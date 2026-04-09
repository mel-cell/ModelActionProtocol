// =============================================================================
// MAP Critic — Self-healing loop via fast reviewer model
//
// After every executor action, the critic reviews what happened.
// Uses a cheap, fast model to evaluate whether the action was
// correct, needs correction, or should be flagged for human review.
//
// Tiered model routing:
//   - Cheap decisions → cheap models (fast critique)
//   - Expensive reasoning → capable models (execution)
//
// The critic never modifies state directly. It returns a verdict and
// optional correction. The executor applies corrections if autoCorrect
// is enabled.
// =============================================================================

import type { CriticResult, ActionRecord } from "./protocol.js";

/**
 * CriticFunction type — pluggable critic implementations.
 * The default uses an LLM, but you can provide a deterministic
 * rule-based critic for testing or specific domains.
 */
export type CriticFunction = (params: {
  goal: string;
  action: ActionRecord;
  stateBefore: unknown;
  stateAfter: unknown;
  previousActions: ActionRecord[];
}) => Promise<CriticResult>;

/**
 * Create a critic powered by an LLM via the AI SDK.
 *
 * Uses generateText with Output.object() for structured output —
 * the critic always returns a typed CriticResult, never freeform text.
 */
export function createLLMCritic(options: {
  model: string;
  generateText: (params: any) => Promise<any>;
}): CriticFunction {
  return async ({ goal, action, stateBefore, stateAfter, previousActions }) => {
    const prompt = `You are a critic reviewing an autonomous AI agent's action.
Your job is to determine if the action was correct, needs correction, or is dangerous.

GOAL: ${goal}

ACTION TAKEN:
- Tool: ${action.tool}
- Input: ${JSON.stringify(action.input, null, 2)}
- Output: ${JSON.stringify(action.output, null, 2)}

STATE BEFORE ACTION:
${JSON.stringify(stateBefore, null, 2)}

STATE AFTER ACTION:
${JSON.stringify(stateAfter, null, 2)}

PREVIOUS ACTIONS IN THIS SESSION:
${previousActions.map((a, i) => `${i + 1}. ${a.tool}(${JSON.stringify(a.input)})`).join("\n")}

Evaluate:
1. Did the action move toward the goal correctly?
2. Is the state after the action consistent and valid?
3. Are there any data integrity issues (nulls, zeros, missing records, wrong values)?
4. Is this action potentially destructive or irreversible?

Respond with:
- verdict: "PASS" if correct, "CORRECTED" if fixable error (provide the fix), "FLAGGED" if dangerous
- reason: Brief explanation
- correction: If verdict is CORRECTED, provide the tool name and input to fix it`;

    try {
      const result = await options.generateText({
        model: options.model,
        prompt,
        output: {
          type: "object",
          schema: {
            type: "object",
            properties: {
              verdict: { type: "string", enum: ["PASS", "CORRECTED", "FLAGGED"] },
              reason: { type: "string" },
              correction: {
                type: "object",
                properties: {
                  tool: { type: "string" },
                  input: { type: "object" },
                },
              },
            },
            required: ["verdict", "reason"],
          },
        },
      });

      return result.object as CriticResult;
    } catch (error) {
      // Fail closed: a broken critic should halt, not silently approve.
      // If the critic can't review an action, it's unsafe to proceed.
      return {
        verdict: "FLAGGED" as const,
        reason: `Critic unavailable (defaulting to FLAGGED): ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  };
}

/**
 * Create a deterministic rule-based critic.
 * Useful for testing, demos, and domain-specific validation
 * where you don't need LLM judgment.
 */
export function createRuleCritic(
  rules: Array<{
    name: string;
    check: (params: {
      action: ActionRecord;
      stateBefore: unknown;
      stateAfter: unknown;
    }) => CriticResult | null;
  }>
): CriticFunction {
  return async ({ action, stateBefore, stateAfter }) => {
    for (const rule of rules) {
      const result = rule.check({ action, stateBefore, stateAfter });
      if (result && result.verdict !== "PASS") {
        return result;
      }
    }
    return { verdict: "PASS", reason: "All rules passed" };
  };
}

// ─── Risk Tier ──────────────────────────────────────────────────────────────

export type RiskTier = "low" | "medium" | "high";

/**
 * Classify an action's risk tier based on its tool name and input.
 * Used by createTieredCritic to route actions to the right reviewer.
 */
export type RiskClassifier = (action: ActionRecord) => RiskTier;

/**
 * Default risk classifier — infers tier from tool name patterns.
 * Override with a custom classifier for domain-specific routing.
 *
 *   low:    read-only operations (query, list, get, search, detect, audit)
 *   high:   destructive/irreversible (delete, transfer, send, deploy, close, drop)
 *   medium: everything else (update, create, adjust, reclassify)
 */
export const defaultRiskClassifier: RiskClassifier = (action) => {
  const tool = action.tool.toLowerCase();

  const lowPatterns = ["query", "list", "get", "search", "detect", "audit", "read", "fetch", "scan"];
  const highPatterns = ["delete", "transfer", "send", "deploy", "close", "drop", "wire", "terminate", "destroy", "remove"];

  if (lowPatterns.some((p) => tool.includes(p))) return "low";
  if (highPatterns.some((p) => tool.includes(p))) return "high";
  return "medium";
};

/**
 * Create a tiered critic that routes actions to different reviewers
 * based on risk level.
 *
 * Production architecture:
 *   Low-risk:    Rule-based programmatic checks (microseconds)
 *   Medium-risk: Claude Haiku (200ms)
 *   High-risk:   Claude Sonnet (1-2s) for deep reasoning
 *
 * Tiered model routing — cheap decisions go to cheap models,
 * expensive reasoning goes to capable models.
 *
 * Example:
 *   const critic = createTieredCritic({
 *     low:    createRuleCritic(rules),
 *     medium: createLLMCritic({ model: 'claude-haiku-4.5', generateText }),
 *     high:   createLLMCritic({ model: 'claude-sonnet-4.6', generateText }),
 *   });
 *
 * With custom classifier:
 *   const critic = createTieredCritic({
 *     low:    createRuleCritic(rules),
 *     medium: createLLMCritic({ model: 'claude-haiku-4.5', generateText }),
 *     high:   createLLMCritic({ model: 'claude-sonnet-4.6', generateText }),
 *     classify: (action) => {
 *       if (action.input.amount > 100000) return 'high';
 *       if (action.tool === 'queryAccounts') return 'low';
 *       return 'medium';
 *     },
 *   });
 */
export function createTieredCritic(options: {
  /** Critic for low-risk actions — fast, deterministic (microseconds) */
  low: CriticFunction;
  /** Critic for medium-risk actions — fast LLM like Haiku (~200ms) */
  medium: CriticFunction;
  /** Critic for high-risk actions — capable LLM like Sonnet (~1-2s) */
  high: CriticFunction;
  /** Custom risk classifier — defaults to tool-name pattern matching */
  classify?: RiskClassifier;
}): CriticFunction {
  const classify = options.classify ?? defaultRiskClassifier;

  return async (params) => {
    const tier = classify(params.action);

    const critic = tier === "low"
      ? options.low
      : tier === "high"
        ? options.high
        : options.medium;

    const result = await critic(params);

    // Annotate the result with which tier handled it (for cost tracking)
    return {
      ...result,
      reason: `[${tier}] ${result.reason}`,
    };
  };
}
