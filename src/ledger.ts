// =============================================================================
// MAP Ledger — Append-only cryptographic action log
//
// The ledger is the core data structure of the MAP protocol. It follows
// a "messages as state" pattern: the ledger IS the execution state.
// The full history of what happened, why, and what the state was at
// every point is reconstructible from the ledger alone.
//
// Each entry chains to the previous via SHA-256 hash, making the ledger
// tamper-evident. Modify one entry and every subsequent hash breaks.
// =============================================================================

import { randomUUID } from "crypto";
import type {
  LedgerEntry,
  ActionRecord,
  CriticResult,
  MAPEventHandler,
  MAPEvent,
} from "./protocol.js";
import { MAP_VERSION, MAP_PROTOCOL } from "./protocol.js";
import { captureSnapshot, computeEntryHash } from "./snapshot.js";
import { LedgerStore } from "./store.js";

export class Ledger {
  private entries: LedgerEntry[] = [];
  private listeners: MAPEventHandler[] = [];
  private serializeState?: (state: unknown) => string;
  private store?: LedgerStore;

  constructor(options?: { 
    serializeState?: (state: unknown) => string,
    store?: LedgerStore 
  }) {
    this.serializeState = options?.serializeState;
    this.store = options?.store;
  }

  /**
   * Static factory to create and initialize a ledger from a persistent store.
   * This is the recommended way to instantiate a ledger when using a store.
   */
  static async load(options?: { 
    serializeState?: (state: unknown) => string,
    store?: LedgerStore 
  }): Promise<Ledger> {
    const ledger = new Ledger(options);
    await ledger.init();
    return ledger;
  }

  /**
   * Initialize the ledger by loading entries from the persistent store.
   * Should be called after instantiation if not using Ledger.load().
   */
  async init(): Promise<void> {
    if (this.store) {
      this.entries = await this.store.getEntries();
    }
  }

  /**
   * Subscribe to ledger events for real-time UI updates.
   * Returns an unsubscribe function.
   */
  on(handler: MAPEventHandler): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((h) => h !== handler);
    };
  }

  /**
   * Emit an event to all listeners.
   * Exposed for use by the executor harness. Listener errors are caught
   * to prevent a broken handler from corrupting ledger state.
   *
   * @internal
   */
  emit(event: MAPEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must never corrupt the ledger.
      }
    }
  }

  /**
   * Append a new entry to the ledger.
   *
   * Takes the action performed, the state before and after, and the
   * critic's verdict. Computes the cryptographic hash chaining this
   * entry to the previous one.
   */
  async append(
    action: ActionRecord,
    stateBefore: unknown,
    stateAfter: unknown,
    critic: CriticResult
  ): Promise<LedgerEntry> {
    const sequence = this.entries.length;
    const parentHash =
      sequence > 0 ? this.entries[sequence - 1].hash : "0".repeat(64);

    const before = captureSnapshot(stateBefore, this.serializeState);
    const after = captureSnapshot(stateAfter, this.serializeState);

    const hash = computeEntryHash(
      sequence,
      action,
      before.hash,
      after.hash,
      parentHash,
      critic
    );

    const entry: LedgerEntry = {
      id: randomUUID(),
      sequence,
      timestamp: new Date().toISOString(),
      action,
      stateBefore: before.hash,
      stateAfter: after.hash,
      snapshots: {
        before: before.serialized,
        after: after.serialized,
      },
      parentHash,
      hash,
      critic,
      status: "ACTIVE",
    };

    this.entries.push(entry);

    if (this.store) {
      await this.store.append(entry);
    }

    this.emit({ type: "action:complete", entry });
    this.emit({ type: "critic:verdict", entry });

    if (critic.verdict === "FLAGGED") {
      this.emit({ type: "flagged", entry });
    }

    return entry;
  }

  /**
   * Mark all entries after (and including) the target as ROLLED_BACK.
   * Append a rollback entry to the ledger (the rollback itself is provenance).
   * Returns the state snapshot from before the target entry.
   */
  async rollbackTo(targetId: string): Promise<{ state: unknown; entriesReverted: number }> {
    const targetIdx = this.entries.findIndex((e) => e.id === targetId);
    if (targetIdx === -1) {
      throw new Error(`Ledger entry ${targetId} not found`);
    }

    const target = this.entries[targetIdx];
    this.emit({ type: "rollback:start", targetId });

    // Mark all entries from target onwards as rolled back
    let reverted = 0;
    for (let i = targetIdx; i < this.entries.length; i++) {
      if (this.entries[i].status !== "ROLLED_BACK") {
        this.entries[i] = { ...this.entries[i], status: "ROLLED_BACK" };
        
        if (this.store) {
          await this.store.updateStatus(this.entries[i].id, "ROLLED_BACK");
        }

        reverted++;
      }
    }

    // Append a rollback entry — the rollback itself is part of the chain
    const rollbackAction: ActionRecord = {
      tool: "ROLLBACK",
      input: { targetId, targetSequence: target.sequence },
      output: { entriesReverted: reverted, restoredToHash: target.stateBefore },
    };

    // State before rollback = current state (last committed entry's after)
    const lastCommitted = [...this.entries]
      .reverse()
      .find((e) => e.status === "ACTIVE" && e.action.tool !== "ROLLBACK");
    const currentState = lastCommitted?.snapshots.after ?? target.snapshots.before;

    await this.append(
      rollbackAction,
      currentState,
      target.snapshots.before,
      { verdict: "PASS", reason: `Rollback to entry ${target.sequence}` }
    );

    this.emit({ type: "rollback:complete", targetId, entriesReverted: reverted });

    // Return the state to restore to
    return { state: target.snapshots.before, entriesReverted: reverted };
  }

  /**
   * Get all ledger entries.
   */
  getEntries(): readonly LedgerEntry[] {
    return this.entries;
  }

  /**
   * Get only committed (non-rolled-back) entries.
   */
  getCommittedEntries(): LedgerEntry[] {
    return this.entries.filter((e) => e.status === "ACTIVE");
  }

  /**
   * Get a single entry by ID.
   */
  getEntry(id: string): LedgerEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Export the full ledger as a JSON-serializable object.
   * Suitable for audit compliance, regulatory export, or debugging.
   */
  export(): {
    protocol: string;
    version: string;
    entries: LedgerEntry[];
    stats: {
      total: number;
      committed: number;
      rolledBack: number;
      corrections: number;
      flags: number;
    };
  } {
    return {
      protocol: MAP_PROTOCOL,
      version: MAP_VERSION,
      entries: [...this.entries],
      stats: this.getStats(),
    };
  }

  /**
   * Get summary statistics for the session.
   */
  getStats() {
    const committed = this.entries.filter(
      (e) => e.status === "ACTIVE" && e.action.tool !== "ROLLBACK"
    ).length;
    const rolledBack = this.entries.filter(
      (e) => e.status === "ROLLED_BACK"
    ).length;
    const corrections = this.entries.filter(
      (e) => e.critic.verdict === "CORRECTED"
    ).length;
    const flags = this.entries.filter(
      (e) => e.critic.verdict === "FLAGGED"
    ).length;

    return {
      total: this.entries.length,
      committed,
      rolledBack,
      corrections,
      flags,
    };
  }

  /**
   * Clear the ledger. Intended for testing and session reset only.
   * WARNING: This destroys the audit trail irreversibly.
   * @internal
   */
  async clear(): Promise<void> {
    this.entries = [];
    if (this.store) {
      await this.store.clear();
    }
  }
}
