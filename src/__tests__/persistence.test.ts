import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Ledger } from "../ledger.js";
import { SQLiteLedgerStore } from "../adapters/sqlite.js";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

describe("SQLite Persistence", () => {
  let dbPath: string;

  beforeEach(() => {
    // Use system temp directory for more robust CI testing
    const suffix = randomBytes(4).toString("hex");
    dbPath = join(tmpdir(), `map-test-${suffix}.db`);
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try { unlinkSync(dbPath); } catch {}
    }
  });

  it("should persist entries across restarts", async () => {
    const store = new SQLiteLedgerStore(dbPath);
    const ledger = new Ledger({ store });
    await ledger.init();

    // 1. Add some entries
    await ledger.append(
      { tool: "testTool", input: { item: "A" }, output: { success: true } },
      { count: 0 },
      { count: 1 },
      { verdict: "PASS", reason: "All good" }
    );

    await ledger.append(
      { tool: "testTool", input: { item: "B" }, output: { success: true } },
      { count: 1 },
      { count: 2 },
      { verdict: "PASS", reason: "All good" }
    );

    expect(ledger.getEntries().length).toBe(2);
    
    // Close store
    store.close();

    // 2. Restart ledger with the same database
    // Pro: Using static Ledger.load() factory
    const store2 = new SQLiteLedgerStore(dbPath);
    const ledger2 = await Ledger.load({ store: store2 });

    const entries = ledger2.getEntries();
    expect(entries.length).toBe(2);
    expect(entries[0].action.tool).toBe("testTool");
    expect((entries[0].action.input as any).item).toBe("A");
    expect((entries[1].action.input as any).item).toBe("B");

    store2.close();
  });

  it("should persist rollback status across restarts", async () => {
    const store = new SQLiteLedgerStore(dbPath);
    const ledger = await Ledger.load({ store });

    const entry1 = await ledger.append(
      { tool: "testTool", input: { v: 1 }, output: { ok: true } },
      {}, {}, { verdict: "PASS", reason: "X" }
    );

    await ledger.append(
      { tool: "testTool", input: { v: 2 }, output: { ok: true } },
      {}, {}, { verdict: "PASS", reason: "X" }
    );

    // Rollback to entry 1
    await ledger.rollbackTo(entry1.id);

    expect(ledger.getEntries().length).toBe(3); // 2 actions + 1 rollback entry
    expect(ledger.getEntry(entry1.id)?.status).toBe("ROLLED_BACK");

    store.close();

    // Restart
    const store2 = new SQLiteLedgerStore(dbPath);
    const ledger2 = await Ledger.load({ store: store2 });

    const entries = ledger2.getEntries();
    expect(entries.length).toBe(3);
    expect(entries.find(e => e.id === entry1.id)?.status).toBe("ROLLED_BACK");

    store2.close();
  });

  it("should clear database on clear()", async () => {
    const store = new SQLiteLedgerStore(dbPath);
    const ledger = await Ledger.load({ store });

    await ledger.append(
      { tool: "test", input: {}, output: {} },
      {}, {}, { verdict: "PASS", reason: "X" }
    );

    expect(ledger.getEntries().length).toBe(1);
    await ledger.clear();
    expect(ledger.getEntries().length).toBe(0);

    store.close();

    // Restart should be empty
    const store2 = new SQLiteLedgerStore(dbPath);
    const ledger2 = await Ledger.load({ store: store2 });
    expect(ledger2.getEntries().length).toBe(0);
    store2.close();
  });

  it("should enforce UNIQUE constraint on sequence", async () => {
    const store = new SQLiteLedgerStore(dbPath);
    
    // Create an entry manually
    const entry: any = {
      id: "uuid-1",
      sequence: 1,
      timestamp: new Date().toISOString(),
      action: { tool: "test", input: {}, output: {} },
      stateBefore: "hash1",
      stateAfter: "hash2",
      snapshots: { before: {}, after: {} },
      parentHash: "0",
      hash: "h1",
      critic: { verdict: "PASS", reason: "ok" },
      status: "ACTIVE"
    };

    await store.append(entry);

    // Try to append another entry with same sequence
    const entry2 = { ...entry, id: "uuid-2" };
    
    // Check error message matches our "Pro" implementation
    await expect(() => store.append(entry2)).rejects.toThrow(/Duplicate sequence number detected/);
    
    store.close();
  });
});
