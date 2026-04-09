// =============================================================================
// MAP — Main class
//
// The public API for @model-action-protocol/core. Three concepts: register tools, run, rollback.
//
//   const map = new MAP({ executor: 'sonnet', critic: 'haiku' });
//   map.registerTool('updateRecord', schema, fn);
//   const session = await map.run({ goal: '...', actions: [...] });
//   session.rollbackTo(entryId);
//   session.exportLedger();
//
// The protocol is MAP. The rollback is the moat.
// =============================================================================

import type {
  MAPTool,
  MAPConfig,
  MAPEventHandler,
  LedgerEntry,
} from "./protocol.js";
import { Ledger } from "./ledger.js";
import type { CriticFunction } from "./critic.js";
import { executeAction, executeSequence } from "./executor.js";
import { executeRollback, findLastProblem, findSafePoint } from "./rollback.js";
import { verifyChain } from "./snapshot.js";
import type { z } from "zod";

export class MAP {
  private tools: Map<string, MAPTool> = new Map();
  private config: MAPConfig;
  private critic: CriticFunction;
  private ledger: Ledger;
  private stateGetter: (() => unknown) | null = null;
  private stateSetter: ((state: unknown) => void) | null = null;

  constructor(config: MAPConfig, critic: CriticFunction) {
    this.config = config;
    this.critic = critic;
    this.ledger = new Ledger({
      serializeState: config.serializeState,
    });
  }

  // ─── Tool Registration ──────────────────────────────────────────────────

  /**
   * Register a tool that agents can call.
   * MAP wraps every call with state snapshots, critic review, and ledger logging.
   */
  registerTool<TInput, TOutput>(
    name: string,
    description: string,
    inputSchema: z.ZodType<TInput>,
    execute: (input: TInput) => Promise<TOutput>
  ): void {
    this.tools.set(name, { name, description, inputSchema, execute });
  }

  /**
   * Register a pre-built MAPTool object.
   */
  addTool(tool: MAPTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Get all registered tools (for passing to the agent's tool definitions).
   */
  getTools(): MAPTool[] {
    return Array.from(this.tools.values());
  }

  // ─── State Management ───────────────────────────────────────────────────

  /**
   * Connect MAP to your environment's state.
   * getState: returns the current state (for snapshots)
   * setState: applies a state (for rollback)
   */
  connectState(
    getState: () => unknown,
    setState: (state: unknown) => void
  ): void {
    this.stateGetter = getState;
    this.stateSetter = setState;
  }

  // ─── Event Handling ─────────────────────────────────────────────────────

  /**
   * Subscribe to MAP events for real-time UI updates.
   */
  on(handler: MAPEventHandler): () => void {
    return this.ledger.on(handler);
  }

  // ─── Execution ──────────────────────────────────────────────────────────

  /**
   * Execute a single tool call through the MAP harness.
   */
  async execute(
    goal: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{
    entry: LedgerEntry;
    halted: boolean;
    corrected: boolean;
  }> {
    this.assertConnected();
    return executeAction(
      {
        goal,
        tools: this.tools,
        critic: this.critic,
        ledger: this.ledger,
        getState: this.stateGetter!,
        setState: this.stateSetter!,
        config: this.config,
      },
      toolName,
      input
    );
  }

  /**
   * Execute a sequence of tool calls through the MAP harness.
   * Each call is logged, critiqued, and rollback-ready.
   */
  async run(
    goal: string,
    actions: Array<{ tool: string; input: Record<string, unknown> }>
  ) {
    this.assertConnected();
    return executeSequence(
      {
        goal,
        tools: this.tools,
        critic: this.critic,
        ledger: this.ledger,
        getState: this.stateGetter!,
        setState: this.stateSetter!,
        config: this.config,
      },
      actions
    );
  }

  // ─── Rollback ───────────────────────────────────────────────────────────

  /**
   * Rollback to a specific ledger entry.
   * Restores the state from before that entry's action.
   * The rollback itself is logged to the ledger.
   */
  rollbackTo(entryId: string): {
    state: unknown;
    entriesReverted: number;
  } {
    this.assertConnected();
    const result = executeRollback(this.ledger, entryId);

    // Apply the restored state
    this.stateSetter!(result.state);

    return {
      state: result.state,
      entriesReverted: result.entriesReverted,
    };
  }

  /**
   * Rollback to the last known safe point (before the most recent problem).
   */
  rollbackToSafe(): {
    state: unknown;
    entriesReverted: number;
  } | null {
    const safe = findSafePoint(this.ledger);
    if (!safe) return null;
    return this.rollbackTo(safe.id);
  }

  // ─── Ledger Access ──────────────────────────────────────────────────────

  /**
   * Get the full ledger for UI rendering.
   */
  getLedger(): readonly LedgerEntry[] {
    return this.ledger.getEntries();
  }

  /**
   * Export the full ledger as audit-ready JSON.
   */
  exportLedger() {
    return this.ledger.export();
  }

  /**
   * Verify the integrity of the ledger chain.
   * Returns true if no entries have been tampered with.
   */
  verifyIntegrity(): { valid: boolean; corruptedAt?: number } {
    return verifyChain(
      this.ledger.getEntries().map((e) => ({
        sequence: e.sequence,
        action: e.action,
        stateBefore: e.stateBefore,
        stateAfter: e.stateAfter,
        parentHash: e.parentHash,
        hash: e.hash,
      }))
    );
  }

  /**
   * Get session statistics.
   */
  getStats() {
    return this.ledger.getStats();
  }

  /**
   * Find the most recent problem entry.
   */
  getLastProblem(): LedgerEntry | undefined {
    return findLastProblem(this.ledger);
  }

  /**
   * Reset the session (clear ledger and state).
   */
  reset(): void {
    this.ledger.clear();
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private assertConnected(): void {
    if (!this.stateGetter || !this.stateSetter) {
      throw new Error(
        "MAP: call connectState(getState, setState) before executing actions"
      );
    }
  }
}
