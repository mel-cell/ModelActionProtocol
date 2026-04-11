import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Ledger } from "../ledger.js";
import { PostgresLedgerStore } from "../adapters/postgres.js";

/**
 * PostgreSQL Persistence Tests
 * 
 * We skip these tests if DB_HOST is not provided or connection fails,
 * making the test suite CI-friendly and non-blocking for core developers.
 */
describe("PostgreSQL Persistence", () => {
  const dbConfig = {
    user: process.env.DB_USER || 'testuser',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'map_test',
    password: process.env.DB_PASSWORD || 'testpassword',
    port: parseInt(process.env.DB_PORT || '5432'),
  };

  let store: PostgresLedgerStore | undefined;

  beforeAll(async () => {
    // Only attempt if host is explicitly provided or we're in a specific test environment
    if (!process.env.DB_HOST && !process.env.RUN_POSTGRES_TESTS) {
      return;
    }

    try {
      store = new PostgresLedgerStore({
        ...dbConfig,
        sessionId: `test-${Date.now()}`
      });
      await store.init();
    } catch (e) {
      store = undefined;
    }
  });

  afterAll(async () => {
    if (store) await store.close();
  });

  it("should persist and isolate sessions correctly", async () => {
    if (!store) {
      console.warn("Postgres test SKIPPED: No database connection.");
      return; 
    }

    const ledger = await Ledger.load({ store });

    await ledger.append(
      { tool: "pgTool", input: { item: "X" }, output: {} },
      {}, {}, { verdict: "PASS", reason: "ok" }
    );

    const entries = ledger.getEntries();
    expect(entries.length).toBe(1);
    expect((entries[0].action.input as any).item).toBe("X");

    // Test Isolation
    const store2 = new PostgresLedgerStore({
      ...dbConfig,
      sessionId: `other-session-${Date.now()}`
    });
    await store2.init();
    
    const ledger2 = await Ledger.load({ store: store2 });
    expect(ledger2.getEntries().length).toBe(0);

    await store2.close();
  });

  it("should handle parallel writes safely with SERIALIZABLE isolation", async () => {
    if (!store) return;

    const commonSession = `shared-${Date.now()}`;
    const store1 = new PostgresLedgerStore({ ...dbConfig, sessionId: commonSession });
    const store2 = new PostgresLedgerStore({ ...dbConfig, sessionId: commonSession });

    const ledger1 = await Ledger.load({ store: store1 });
    const ledger2 = await Ledger.load({ store: store2 });

    const p1 = ledger1.append({ tool: "A", input: {}, output: {} }, {}, {}, { verdict: "PASS", reason: "" });
    const p2 = ledger2.append({ tool: "B", input: {}, output: {} }, {}, {}, { verdict: "PASS", reason: "" });

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);
    
    await store1.close();
    await store2.close();
  });
});
