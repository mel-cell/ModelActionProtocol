// =============================================================================
// MAP Executor — Agent harness that wraps tool calls with provenance
//
// This is the core of MAP: a harness that sits between the agent and
// its tools. Every tool call is intercepted, state is snapshotted before
// and after, the critic reviews the result, and everything is logged to
// the cryptographic ledger.
//
// Architecture:
//   - Simple loop: while (agent has tool calls) → execute → critique → log
//   - Tools are schema-driven: registered with Zod schemas
//   - Errors as feedback: critic failures don't crash, they feed back
//   - Tiered models: executor (capable), critic (fast/cheap)
//   - Read-only ops concurrent, mutations serial
// =============================================================================

import type {
  MAPTool,
  MAPConfig,
  ActionRecord,
  CriticResult,
  MAPEventHandler,
} from "./protocol.js";
import { Ledger } from "./ledger.js";
import type { CriticFunction } from "./critic.js";

export interface ExecutorOptions {
  /** The user's goal — what the agent is trying to accomplish */
  goal: string;
  /** Registered tools the agent can call */
  tools: Map<string, MAPTool>;
  /** The critic function (LLM-based or rule-based) */
  critic: CriticFunction;
  /** The ledger to log to */
  ledger: Ledger;
  /** Function that returns the current environment state (for snapshots) */
  getState: () => unknown;
  /** Function that applies a state (for rollback) */
  setState: (state: unknown) => void;
  /** Configuration */
  config: MAPConfig;
}

export interface ExecutionResult {
  /** Whether the execution completed successfully */
  success: boolean;
  /** The final state of the environment */
  finalState: unknown;
  /** Number of actions taken */
  actionsExecuted: number;
  /** Number of corrections made */
  correctionsApplied: number;
  /** Number of flags raised */
  flagsRaised: number;
  /** Whether execution was halted by a flag */
  haltedByFlag: boolean;
  /** The entry that caused the halt, if any */
  haltEntry?: string;
}

/**
 * Execute a single tool call through the MAP harness.
 *
 * 1. Snapshot state before
 * 2. Execute the tool
 * 3. Snapshot state after
 * 4. Run the critic
 * 5. If CORRECTED and autoCorrect → apply correction and re-critique
 * 6. Log everything to the ledger
 * 7. Return the entry
 *
 * This function is the atomic unit of MAP. Everything else builds on it.
 */
export async function executeAction(
  options: ExecutorOptions,
  toolName: string,
  input: Record<string, unknown>
): Promise<{
  entry: Awaited<ReturnType<Ledger["append"]>>;
  halted: boolean;
  corrected: boolean;
}> {
  const { tools, critic, ledger, getState, setState, config, goal } = options;

  const tool = tools.get(toolName);
  if (!tool) {
    throw new Error(`Tool "${toolName}" not registered with MAP`);
  }

  // Emit action start
  ledger.emit({ type: "action:start", tool: toolName, input });

  // 0. ESCALATE check — halt BEFORE execution for irreversible actions
  if (tool.reversal?.strategy === "ESCALATE") {
    const stateBefore = getState();
    const action: ActionRecord = {
      tool: toolName,
      input,
      output: { pending: true, reason: "ESCALATE: awaiting human approval" },
      reversalStrategy: "ESCALATE",
    };
    const entry = await ledger.append(action, stateBefore, stateBefore, {
      verdict: "FLAGGED",
      reason: `Action "${toolName}" requires human approval (ESCALATE strategy)`,
    });
    return { entry, halted: true, corrected: false };
  }

  // 1. Snapshot state before
  const stateBefore = getState();

  // 1b. RESTORE capture — snapshot external state before mutation
  let capturedState: unknown = undefined;
  if (tool.reversal?.strategy === "RESTORE" && "capture" in tool && typeof (tool as any).capture === "function") {
    try {
      capturedState = await (tool as any).capture(input);
    } catch {
      // Capture failed — log but don't block execution
    }
  }

  // 2. Execute the tool
  let output: unknown;
  let executionError = false;
  try {
    const parsed = tool.inputSchema.parse(input);
    output = await tool.execute(parsed);
  } catch (error) {
    executionError = true;
    output = {
      error: true,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }

  // 3. Snapshot state after
  const stateAfter = getState();

  // 3b. If the tool itself errored, flag it without running the critic
  if (executionError) {
    const action: ActionRecord = { tool: toolName, input, output };
    const entry = await ledger.append(action, stateBefore, stateAfter, {
      verdict: "FLAGGED",
      reason: `Tool execution failed: ${(output as any).message}`,
    });
    return { entry, halted: config.pauseOnFlag ?? true, corrected: false };
  }

  // 4. Run the critic
  const previousActions = ledger
    .getCommittedEntries()
    .filter((e) => e.action.tool !== "ROLLBACK")
    .map((e) => e.action);

  const criticResult = await critic({
    goal,
    action: { tool: toolName, input, output },
    stateBefore,
    stateAfter,
    previousActions,
  });

  // 5. If CORRECTED and autoCorrect is enabled, apply the correction
  if (
    criticResult.verdict === "CORRECTED" &&
    criticResult.correction &&
    (config.autoCorrect ?? true)
  ) {
    // Log the original (incorrect) action first
    const originalAction: ActionRecord = {
      tool: toolName, input, output,
      reversalStrategy: tool.reversal?.strategy,
      capturedState,
    };
    const originalEntry = await ledger.append(originalAction, stateBefore, stateAfter, criticResult);

    // Apply the correction
    const correctionTool = tools.get(criticResult.correction.tool);
    if (correctionTool) {
      const correctionStateBefore = getState();
      try {
        // Validate correction input through the tool's schema
        const parsedCorrectionInput = correctionTool.inputSchema.parse(
          criticResult.correction.input
        );
        const correctionOutput = await correctionTool.execute(parsedCorrectionInput);
        const correctionStateAfter = getState();

        // Log the correction
        const correctionAction: ActionRecord = {
          tool: criticResult.correction.tool,
          input: criticResult.correction.input,
          output: correctionOutput,
        };
        const correctionEntry = await ledger.append(
          correctionAction,
          correctionStateBefore,
          correctionStateAfter,
          { verdict: "PASS", reason: "Auto-correction applied" }
        );

        // Emit correction:applied event
        ledger.emit({
          type: "correction:applied",
          original: originalEntry,
          corrected: correctionEntry,
        });

        return { entry: correctionEntry, halted: false, corrected: true };
      } catch {
        // Correction failed — the original (bad) entry is already logged.
        // Return it so the caller knows what happened.
        return { entry: originalEntry, halted: false, corrected: false };
      }
    }

    // Correction tool not found — return the original entry
    return { entry: originalEntry, halted: false, corrected: false };
  }

  // 6. Log to ledger
  const action: ActionRecord = {
    tool: toolName, input, output,
    reversalStrategy: tool.reversal?.strategy,
    capturedState,
  };
  const entry = await ledger.append(action, stateBefore, stateAfter, criticResult);

  // 7. Check if we should halt
  const halted =
    criticResult.verdict === "FLAGGED" && (config.pauseOnFlag ?? true);

  return { entry, halted, corrected: false };
}

/**
 * Run a sequence of tool calls through the MAP harness.
 * This is the "agent loop" — but MAP doesn't run the agent itself.
 * Instead, it wraps whatever tool calls the agent makes.
 *
 * Can be called with a pre-planned sequence for testing,
 * or invoked by the agent's tool dispatch in production.
 */
export async function executeSequence(
  options: ExecutorOptions,
  actions: Array<{ tool: string; input: Record<string, unknown> }>
): Promise<ExecutionResult> {
  let actionsExecuted = 0;
  let correctionsApplied = 0;
  let flagsRaised = 0;
  let haltedByFlag = false;
  let haltEntry: string | undefined;

  const maxActions = options.config.maxActions ?? 50;

  for (const action of actions) {
    if (actionsExecuted >= maxActions) break;

    const result = await executeAction(options, action.tool, action.input);
    actionsExecuted++;

    if (result.corrected) correctionsApplied++;
    if (result.entry.critic.verdict === "FLAGGED") {
      flagsRaised++;
      if (result.halted) {
        haltedByFlag = true;
        haltEntry = result.entry.id;
        break;
      }
    }
  }

  // Emit session complete
  options.ledger.emit({
    type: "session:complete",
    totalActions: actionsExecuted,
    totalCorrections: correctionsApplied,
    totalFlags: flagsRaised,
  });

  return {
    success: !haltedByFlag,
    finalState: options.getState(),
    actionsExecuted,
    correctionsApplied,
    flagsRaised,
    haltedByFlag,
    haltEntry,
  };
}
