import type { LedgerEntry, LedgerEntryStatus } from "./protocol.js";

/**
 * LedgerStore Interface
 * 
 * Provides persistence for ledger entries. Implementations can be:
 * - In-memory (default): Simple array-based storage, not persistent.
 * - SQLite: Local file persistence for single-process use (Implemented).
 * - PostgreSQL: Planned for production-grade, multi-process deployments (See Issue #3).
 */
export interface LedgerStore {
  /** Append a new entry to the store */
  append(entry: LedgerEntry): Promise<void>;
  
  /** Retrieve all entries from the store */
  getEntries(): Promise<LedgerEntry[]>;
  
  /** Retrieve a single entry by ID */
  getEntry(id: string): Promise<LedgerEntry | undefined>;
  
  /** Update the status of an existing entry (e.g., mark as ROLLED_BACK) */
  updateStatus(id: string, status: LedgerEntryStatus): Promise<void>;
  
  /** Clear all entries from the store */
  clear(): Promise<void>;
}
