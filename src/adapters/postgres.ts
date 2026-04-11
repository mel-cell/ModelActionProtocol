import pg from 'pg';
const { Pool } = pg;
import { LedgerEntry, type LedgerEntryStatus } from "../protocol.js";
import type { LedgerStore } from "../store.js";

/**
 * PostgreSQL implementation of the LedgerStore.
 * 
 * Production-grade storage with connection pooling, JSONB support,
 * session isolation, and automatic retry logic for concurrent writes.
 */
export class PostgresLedgerStore implements LedgerStore {
  private pool: pg.Pool;
  private tableName: string;
  private sessionId: string;
  private maxRetries = 5;

  constructor(config: pg.PoolConfig & { tableName?: string, sessionId?: string, maxRetries?: number }) {
    this.tableName = config.tableName || 'ledger_entries';
    this.sessionId = config.sessionId || 'default';
    this.maxRetries = config.maxRetries ?? 5;
    this.pool = new Pool(config);
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL,
          action JSONB NOT NULL,
          state_before TEXT NOT NULL,
          state_after TEXT NOT NULL,
          snapshots JSONB NOT NULL,
          parent_hash TEXT NOT NULL,
          hash TEXT NOT NULL,
          critic JSONB NOT NULL,
          status TEXT NOT NULL,
          approval JSONB,
          agent_id TEXT,
          parent_entry_id TEXT,
          lineage JSONB,
          state_version INTEGER,
          UNIQUE(session_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_session_sequence ON ${this.tableName}(session_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_ledger_status ON ${this.tableName}(status);
        CREATE INDEX IF NOT EXISTS idx_ledger_action_gin ON ${this.tableName} USING GIN (action);
      `);
    } finally {
      client.release();
    }
  }

  /**
   * Appends an entry with automatic retries for serialization conflicts.
   */
  async append(entry: LedgerEntry): Promise<void> {
    return this.withRetry(async (client) => {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try {
        await client.query(
          `INSERT INTO ${this.tableName} (
            id, session_id, sequence, timestamp, action, state_before, state_after, 
            snapshots, parent_hash, hash, critic, status, approval,
            agent_id, parent_entry_id, lineage, state_version
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            entry.id,
            this.sessionId,
            entry.sequence,
            entry.timestamp,
            entry.action,
            entry.stateBefore,
            entry.stateAfter,
            entry.snapshots,
            entry.parentHash,
            entry.hash,
            entry.critic,
            entry.status,
            entry.approval || null,
            entry.agentId || null,
            entry.parentEntryId || null,
            entry.lineage || null,
            entry.stateVersion || null
          ]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  }

  async getEntries(): Promise<LedgerEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.tableName} WHERE session_id = $1 ORDER BY sequence ASC`,
      [this.sessionId]
    );
    return rows.map(row => this.mapRowToEntry(row));
  }

  async getEntry(id: string): Promise<LedgerEntry | undefined> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.tableName} WHERE id = $1 AND session_id = $2`,
      [id, this.sessionId]
    );
    return rows[0] ? this.mapRowToEntry(rows[0]) : undefined;
  }

  async updateStatus(id: string, status: LedgerEntryStatus): Promise<void> {
    await this.withRetry(async (client) => {
      const result = await client.query(
        `UPDATE ${this.tableName} SET status = $1 WHERE id = $2 AND session_id = $3`,
        [status, id, this.sessionId]
      );
      if (result.rowCount === 0) {
        throw new Error(`MAP PostgresStore: Entry ${id} not found.`);
      }
    });
  }

  async clear(): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.tableName} WHERE session_id = $1`,
      [this.sessionId]
    );
  }

  /**
   * Helper to wrap DB operations with retry logic for serialization errors (40001).
   */
  private async withRetry<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    let lastError: any;
    for (let i = 0; i < this.maxRetries; i++) {
      const client = await this.pool.connect();
      try {
        return await fn(client);
      } catch (err: any) {
        lastError = err;
        // Postgres Error 40001: serialization_failure (the classic SERIALIZABLE conflict)
        if (err.code === '40001') {
          // Jittered backoff to prevent thundering herd
          const delay = Math.random() * (Math.pow(2, i) * 50);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue; 
        }
        // Unique violation (23505) - this means someone actually won the sequence race
        if (err.code === '23505') {
          throw new Error(`MAP PostgresStore: Duplicate sequence detected. Persistent integrity violation.`);
        }
        throw err;
      } finally {
        client.release();
      }
    }
    throw lastError;
  }

  private mapRowToEntry(row: any): LedgerEntry {
    const data = {
      id: row.id,
      sequence: row.sequence,
      timestamp: row.timestamp.toISOString(),
      action: row.action,
      stateBefore: row.state_before,
      stateAfter: row.state_after,
      snapshots: row.snapshots,
      parentHash: row.parent_hash,
      hash: row.hash,
      critic: row.critic,
      status: row.status as LedgerEntryStatus,
      approval: row.approval || undefined,
      agentId: row.agent_id || undefined,
      parentEntryId: row.parent_entry_id || undefined,
      lineage: row.lineage || undefined,
      stateVersion: row.state_version || undefined,
    };

    return LedgerEntry.parse(data);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
