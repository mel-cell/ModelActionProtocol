import Database from "better-sqlite3";
import { LedgerEntry, type LedgerEntryStatus } from "../protocol.js";
import type { LedgerStore } from "../store.js";

/**
 * SQLite implementation of the LedgerStore.
 * 
 * Persists entries to a local SQLite database file using better-sqlite3.
 * Optimized with prepared statement caching, WAL mode, and atomic transactions.
 */
export class SQLiteLedgerStore implements LedgerStore {
  private db: Database.Database;
  private statements: {
    insert: Database.Statement;
    updateStatus: Database.Statement;
    selectAll: Database.Statement;
    selectById: Database.Statement;
    delete: Database.Statement;
  };

  constructor(path: string = "map.db") {
    try {
      this.db = new Database(path);
    } catch (error) {
      throw new Error(
        `MAP SQLiteStore: Failed to open database at "${path}". ` +
        `Ensure the directory exists and is writable.`
      );
    }

    this.init();
    
    // Prepare statements for reuse (performance optimization)
    this.statements = {
      insert: this.db.prepare(`
        INSERT INTO entries (
          id, sequence, timestamp, action, stateBefore, stateAfter, 
          snapshots, parentHash, hash, critic, status, approval,
          agentId, parentEntryId, lineage, stateVersion
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateStatus: this.db.prepare("UPDATE entries SET status = ? WHERE id = ?"),
      selectAll: this.db.prepare("SELECT * FROM entries ORDER BY sequence ASC"),
      selectById: this.db.prepare("SELECT * FROM entries WHERE id = ?"),
      delete: this.db.prepare("DELETE FROM entries"),
    };
  }

  private init() {
    // Enable WAL mode for better read/write concurrency
    this.db.pragma('journal_mode = WAL');

    // Create the entries table with strict constraints
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        stateBefore TEXT NOT NULL,
        stateAfter TEXT NOT NULL,
        snapshots TEXT NOT NULL,
        parentHash TEXT NOT NULL,
        hash TEXT NOT NULL,
        critic TEXT NOT NULL,
        status TEXT NOT NULL,
        approval TEXT,
        agentId TEXT,
        parentEntryId TEXT,
        lineage TEXT,
        stateVersion INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_entries_sequence ON entries(sequence);
    `);
  }

  async append(entry: LedgerEntry): Promise<void> {
    try {
      this.statements.insert.run(
        entry.id,
        entry.sequence,
        entry.timestamp,
        JSON.stringify(entry.action),
        entry.stateBefore,
        entry.stateAfter,
        JSON.stringify(entry.snapshots),
        entry.parentHash,
        entry.hash,
        JSON.stringify(entry.critic),
        entry.status,
        entry.approval || null,
        entry.agentId || null,
        entry.parentEntryId || null,
        entry.lineage ? JSON.stringify(entry.lineage) : null,
        entry.stateVersion || null
      );
    } catch (error) {
      if ((error as any).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error(`MAP SQLiteStore: Duplicate sequence number detected (${entry.sequence}). Hash chain integrity at risk.`);
      }
      throw error;
    }
  }

  async getEntries(): Promise<LedgerEntry[]> {
    const rows = this.statements.selectAll.all();
    return rows.map((row: any) => this.mapRowToEntry(row));
  }

  async getEntry(id: string): Promise<LedgerEntry | undefined> {
    const row = this.statements.selectById.get(id);
    return row ? this.mapRowToEntry(row) : undefined;
  }

  async updateStatus(id: string, status: LedgerEntryStatus): Promise<void> {
    const result = this.statements.updateStatus.run(status, id);
    if (result.changes === 0) {
      throw new Error(`MAP SQLiteStore: Entry with ID ${id} not found for status update.`);
    }
  }

  async clear(): Promise<void> {
    const clearAll = this.db.transaction(() => {
      this.statements.delete.run();
    });
    clearAll();
  }

  private mapRowToEntry(row: any): LedgerEntry {
    try {
      const data = {
        id: row.id,
        sequence: row.sequence,
        timestamp: row.timestamp,
        action: JSON.parse(row.action),
        stateBefore: row.stateBefore,
        stateAfter: row.stateAfter,
        snapshots: JSON.parse(row.snapshots),
        parentHash: row.parentHash,
        hash: row.hash,
        critic: JSON.parse(row.critic),
        status: row.status as LedgerEntryStatus,
        approval: row.approval || undefined,
        agentId: row.agentId || undefined,
        parentEntryId: row.parentEntryId || undefined,
        lineage: row.lineage ? JSON.parse(row.lineage) : undefined,
        stateVersion: row.stateVersion || undefined,
      };

      return LedgerEntry.parse(data);
    } catch (error) {
      throw new Error(`MAP SQLiteStore: Corruption detected in ledger entry ${row.id}. Data does not match protocol schema.`);
    }
  }

  close(): void {
    this.db.close();
  }
}
