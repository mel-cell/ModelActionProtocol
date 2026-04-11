// =============================================================================
// @model-action-protocol/core — Edge case tests
//
// Covers: serialization, tool-builder, learning engine, critic failure,
// rollback edge cases, concurrent execution, chain verification
// =============================================================================

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MAP } from "../map.js";
import { createRuleCritic, createTieredCritic, defaultRiskClassifier } from "../critic.js";
import { serializeState, verifyChain, captureSnapshot, sha256, computeEntryHash } from "../snapshot.js";
import { defineTool, defineRestoreTool, defineCompensateTool, defineEscalateTool } from "../tool-builder.js";
import { LearningEngine } from "../learning.js";
import { Ledger } from "../ledger.js";
import type { LedgerEntry, MAPEvent } from "../protocol.js";

// ─── serializeState ─────────────────────────────────────────────────────────

describe("serializeState", () => {
  it("produces deterministic output regardless of key order", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    expect(serializeState(a)).toBe(serializeState(b));
  });

  it("sorts nested object keys recursively", () => {
    const a = { outer: { z: 1, a: 2 }, first: true };
    const b = { first: true, outer: { a: 2, z: 1 } };
    expect(serializeState(a)).toBe(serializeState(b));
  });

  it("sorts deeply nested objects", () => {
    const a = { l1: { l2: { z: 1, a: 2 } } };
    const b = { l1: { l2: { a: 2, z: 1 } } };
    expect(serializeState(a)).toBe(serializeState(b));
  });

  it("handles null without crashing", () => {
    expect(() => serializeState(null)).not.toThrow();
    expect(serializeState(null)).toBe("null");
  });

  it("handles undefined without crashing", () => {
    expect(() => serializeState(undefined)).not.toThrow();
  });

  it("handles primitives without crashing", () => {
    expect(serializeState(42)).toBe("42");
    expect(serializeState("hello")).toBe('"hello"');
    expect(serializeState(true)).toBe("true");
  });

  it("handles arrays (preserves order, does not sort)", () => {
    const arr = [3, 1, 2];
    expect(serializeState(arr)).toBe("[3,1,2]");
  });

  it("handles arrays of objects with deterministic key order", () => {
    const a = [{ z: 1, a: 2 }];
    const b = [{ a: 2, z: 1 }];
    expect(serializeState(a)).toBe(serializeState(b));
  });

  it("handles empty objects and arrays", () => {
    expect(serializeState({})).toBe("{}");
    expect(serializeState([])).toBe("[]");
  });
});

// ─── verifyChain ────────────────────────────────────────────────────────────

describe("verifyChain", () => {
  it("returns valid for an empty chain", () => {
    expect(verifyChain([])).toEqual({ valid: true });
  });

  it("detects non-zero genesis parentHash", () => {
    const entry = {
      sequence: 0,
      action: { tool: "test", input: {}, output: null },
      stateBefore: sha256("before"),
      stateAfter: sha256("after"),
      parentHash: "bad_genesis_hash",
      hash: "", // will be wrong anyway
    };
    const result = verifyChain([entry]);
    expect(result.valid).toBe(false);
    expect(result.corruptedAt).toBe(0);
  });

  it("detects sequence gaps", () => {
    const genesis = "0".repeat(64);
    const entry0 = {
      sequence: 0,
      action: { tool: "test", input: {}, output: null },
      stateBefore: sha256("s0"),
      stateAfter: sha256("s1"),
      parentHash: genesis,
      hash: "",
    };
    // Compute real hash for entry0
    entry0.hash = computeEntryHash(0, entry0.action, entry0.stateBefore, entry0.stateAfter, genesis);

    const entry1 = {
      sequence: 5, // gap!
      action: { tool: "test", input: {}, output: null },
      stateBefore: sha256("s1"),
      stateAfter: sha256("s2"),
      parentHash: entry0.hash,
      hash: "",
    };
    entry1.hash = computeEntryHash(5, entry1.action, entry1.stateBefore, entry1.stateAfter, entry0.hash) as string;

    const result = verifyChain([entry0, entry1]);
    expect(result.valid).toBe(false);
    expect(result.corruptedAt).toBe(1);
  });
});

// ─── Tool Builder ───────────────────────────────────────────────────────────

describe("tool-builder", () => {
  it("defineTool creates a valid MAPTool", () => {
    const tool = defineTool({
      name: "testTool",
      description: "A test tool",
      inputSchema: z.object({ value: z.number() }),
      execute: async (input) => ({ result: input.value * 2 }),
      reversal: { strategy: "RESTORE", description: "Restore test" },
    });

    expect(tool.name).toBe("testTool");
    expect(tool.reversal?.strategy).toBe("RESTORE");
  });

  it("defineRestoreTool sets RESTORE strategy and exposes capture/restore", () => {
    let captured: any = null;
    const tool = defineRestoreTool({
      name: "updateRecord",
      description: "Update a record",
      inputSchema: z.object({ id: z.string(), value: z.number() }),
      execute: async (input) => ({ updated: true }),
      capture: async (input) => {
        captured = { id: input.id, originalValue: 100 };
        return captured;
      },
      restore: async (cap) => {
        captured = cap;
      },
    });

    expect(tool.reversal?.strategy).toBe("RESTORE");
    expect(typeof tool.capture).toBe("function");
    expect(typeof tool.restore).toBe("function");
  });

  it("defineCompensateTool sets COMPENSATE strategy", () => {
    const tool = defineCompensateTool({
      name: "chargeCard",
      description: "Charge a card",
      inputSchema: z.object({ amount: z.number() }),
      execute: async (input) => ({ chargeId: "ch_123" }),
      compensate: async (input, output) => ({ refundId: "re_123" }),
    });

    expect(tool.reversal?.strategy).toBe("COMPENSATE");
    expect(typeof tool.compensate).toBe("function");
  });

  it("defineEscalateTool sets ESCALATE strategy with approver", () => {
    const tool = defineEscalateTool({
      name: "wireTransfer",
      description: "Send wire",
      inputSchema: z.object({ amount: z.number() }),
      execute: async (input) => ({ transferId: "tr_123" }),
      approver: "treasury@acme.com",
    });

    expect(tool.reversal?.strategy).toBe("ESCALATE");
    expect(tool.reversal?.approver).toBe("treasury@acme.com");
  });

  it("tool execute actually runs through the schema", async () => {
    const tool = defineTool({
      name: "double",
      description: "Double a number",
      inputSchema: z.object({ value: z.number() }),
      execute: async (input) => input.value * 2,
      reversal: { strategy: "RESTORE" },
    });

    const result = await tool.execute({ value: 5 });
    expect(result).toBe(10);
  });
});

// ─── Risk Classifier ────────────────────────────────────────────────────────

describe("defaultRiskClassifier", () => {
  it("classifies read operations as low", () => {
    expect(defaultRiskClassifier({ tool: "queryAccounts", input: {}, output: null })).toBe("low");
    expect(defaultRiskClassifier({ tool: "listUsers", input: {}, output: null })).toBe("low");
    expect(defaultRiskClassifier({ tool: "getBalance", input: {}, output: null })).toBe("low");
  });

  it("classifies destructive operations as high", () => {
    expect(defaultRiskClassifier({ tool: "deleteRecord", input: {}, output: null })).toBe("high");
    expect(defaultRiskClassifier({ tool: "sendEmail", input: {}, output: null })).toBe("high");
    expect(defaultRiskClassifier({ tool: "wireTransfer", input: {}, output: null })).toBe("high");
  });

  it("classifies everything else as medium", () => {
    expect(defaultRiskClassifier({ tool: "updatePrice", input: {}, output: null })).toBe("medium");
    expect(defaultRiskClassifier({ tool: "createInvoice", input: {}, output: null })).toBe("medium");
  });
});

// ─── Tiered Critic ──────────────────────────────────────────────────────────

describe("createTieredCritic", () => {
  it("routes to the correct critic based on risk tier", async () => {
    const calls: string[] = [];

    const lowCritic = async () => {
      calls.push("low");
      return { verdict: "PASS" as const, reason: "low" };
    };
    const mediumCritic = async () => {
      calls.push("medium");
      return { verdict: "PASS" as const, reason: "medium" };
    };
    const highCritic = async () => {
      calls.push("high");
      return { verdict: "PASS" as const, reason: "high" };
    };

    const critic = createTieredCritic({ low: lowCritic, medium: mediumCritic, high: highCritic });

    await critic({ goal: "test", action: { tool: "queryData", input: {}, output: null }, stateBefore: {}, stateAfter: {}, previousActions: [] });
    await critic({ goal: "test", action: { tool: "updateRecord", input: {}, output: null }, stateBefore: {}, stateAfter: {}, previousActions: [] });
    await critic({ goal: "test", action: { tool: "deleteAll", input: {}, output: null }, stateBefore: {}, stateAfter: {}, previousActions: [] });

    expect(calls).toEqual(["low", "medium", "high"]);
  });
});

// ─── Learning Engine ────────────────────────────────────────────────────────

describe("LearningEngine", () => {
  function makeMockEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
    return {
      id: crypto.randomUUID(),
      sequence: 0,
      timestamp: new Date().toISOString(),
      action: { tool: "updatePrice", input: { price: 0 }, output: null },
      stateBefore: "hash_before",
      stateAfter: "hash_after",
      snapshots: { before: {}, after: {} },
      parentHash: "0".repeat(64),
      hash: "entry_hash",
      critic: {
        verdict: "CORRECTED",
        reason: "Price was set to $0",
        correction: { tool: "updatePrice", input: { price: 299 } },
      },
      status: "ACTIVE",
      ...overrides,
    } as LedgerEntry;
  }

  it("detects repeated correction patterns", () => {
    const engine = new LearningEngine();
    const entries = [
      makeMockEntry(),
      makeMockEntry(),
      makeMockEntry(),
    ];

    const patterns = engine.analyzePatterns(entries);
    expect(patterns.length).toBe(1);
    expect(patterns[0].count).toBe(3);
    expect(patterns[0].tool).toBe("updatePrice");
  });

  it("proposes rules when threshold is met", () => {
    const engine = new LearningEngine();
    const entries = [makeMockEntry(), makeMockEntry(), makeMockEntry()];

    const proposals = engine.proposeRules(entries, 3);
    expect(proposals.length).toBe(1);
    expect(proposals[0].approved).toBe(false);
    expect(proposals[0].observedCount).toBe(3);
  });

  it("does not propose rules below threshold", () => {
    const engine = new LearningEngine();
    const entries = [makeMockEntry(), makeMockEntry()];

    const proposals = engine.proposeRules(entries, 3);
    expect(proposals.length).toBe(0);
  });

  it("approved rules become a working critic", async () => {
    const engine = new LearningEngine();
    const entries = [makeMockEntry(), makeMockEntry(), makeMockEntry()];

    const proposals = engine.proposeRules(entries, 3);
    proposals.forEach((r) => engine.addProposedRule(r));
    engine.approveRule(proposals[0].id);

    const critic = engine.toRuleCritic();
    const result = await critic({
      goal: "test",
      action: { tool: "updatePrice", input: { price: 0 }, output: null },
      stateBefore: {},
      stateAfter: {},
      previousActions: [],
    });

    expect(result.verdict).not.toBe("PASS");
    expect(result.reason).toContain("[learned]");
  });

  it("unapproved rules do not fire", async () => {
    const engine = new LearningEngine();
    const entries = [makeMockEntry(), makeMockEntry(), makeMockEntry()];

    const proposals = engine.proposeRules(entries, 3);
    proposals.forEach((r) => engine.addProposedRule(r));
    // Don't approve

    const critic = engine.toRuleCritic();
    const result = await critic({
      goal: "test",
      action: { tool: "updatePrice", input: {}, output: null },
      stateBefore: {},
      stateAfter: {},
      previousActions: [],
    });

    expect(result.verdict).toBe("PASS");
  });

  it("exports fine-tuning data from entries with human approval", () => {
    const engine = new LearningEngine();
    const entries = [
      makeMockEntry({ approval: "approved" as any }),
      makeMockEntry(), // no approval — should be excluded
    ];

    const data = engine.exportFineTuningData(entries);
    expect(data.length).toBe(1);
    expect(data[0].humanApproval).toBe("approved");
  });

  it("exports agent memory from correction history", () => {
    const engine = new LearningEngine();
    const entries = [
      makeMockEntry({ agentId: "agent-1" }),
      makeMockEntry({ agentId: "agent-2" }),
    ];

    const memory = engine.exportAgentMemory(entries, "agent-1");
    expect(memory.length).toBe(1);
    expect(memory[0].tool).toBe("updatePrice");
    expect(memory[0].lesson).toContain("auto-corrected");
  });

  it("does not re-propose existing rules", () => {
    const engine = new LearningEngine();
    const entries = [makeMockEntry(), makeMockEntry(), makeMockEntry()];

    const first = engine.proposeRules(entries, 3);
    first.forEach((r) => engine.addProposedRule(r));

    const second = engine.proposeRules(entries, 3);
    expect(second.length).toBe(0);
  });
});

// ─── MAP Class Edge Cases ───────────────────────────────────────────────────

describe("MAP edge cases", () => {
  it("throws when executing without connectState", async () => {
    const map = await MAP.load(
      { executor: "test", critic: "test" },
      createRuleCritic([])
    );
    map.registerTool("noop", "noop", z.object({}), async () => ({}));

    await expect(
      map.execute("test", "noop", {})
    ).rejects.toThrow("connectState");
  });

  it("throws when executing an unregistered tool", async () => {
    const map = await MAP.load(
      { executor: "test", critic: "test" },
      createRuleCritic([])
    );
    map.connectState(() => ({}), () => {});

    await expect(
      map.execute("test", "nonexistent", {})
    ).rejects.toThrow("not registered");
  });

  it("reset clears the ledger", async () => {
    const state = { value: 1 };
    const map = await MAP.load(
      { executor: "test", critic: "test" },
      createRuleCritic([])
    );
    map.registerTool("inc", "increment", z.object({}), async () => {
      state.value++;
      return state.value;
    });
    map.connectState(() => ({ ...state }), (s) => Object.assign(state, s as any));

    await map.execute("test", "inc", {});
    expect(map.getLedger().length).toBe(1);

    await map.reset();
    expect(map.getLedger().length).toBe(0);
  });

  it("rollbackToSafe returns null when no problems exist", async () => {
    const state = { value: 1 };
    const map = await MAP.load(
      { executor: "test", critic: "test" },
      createRuleCritic([])
    );
    map.registerTool("inc", "increment", z.object({}), async () => {
      state.value++;
      return state.value;
    });
    map.connectState(() => ({ ...state }), (s) => Object.assign(state, s as any));

    await map.execute("test", "inc", {});
    expect(await map.rollbackToSafe()).toBeNull();
  });

  it("event listener errors do not crash execution", async () => {
    const state = { value: 1 };
    const map = await MAP.load(
      { executor: "test", critic: "test" },
      createRuleCritic([])
    );
    map.registerTool("inc", "increment", z.object({}), async () => {
      state.value++;
      return state.value;
    });
    map.connectState(() => ({ ...state }), (s) => Object.assign(state, s as any));

    // Register a broken listener
    map.on(() => { throw new Error("broken listener"); });

    // Should not throw
    const result = await map.execute("test", "inc", {});
    expect(result.entry.critic.verdict).toBe("PASS");
  });

  it("unsubscribe removes event listener", async () => {
    const state = { value: 1 };
    const events: MAPEvent[] = [];
    const map = await MAP.load(
      { executor: "test", critic: "test" },
      createRuleCritic([])
    );
    map.registerTool("inc", "increment", z.object({}), async () => {
      state.value++;
      return state.value;
    });
    map.connectState(() => ({ ...state }), (s) => Object.assign(state, s as any));

    const unsub = map.on((e) => events.push(e));
    await map.execute("test", "inc", {});
    const countBefore = events.length;

    unsub();
    await map.execute("test", "inc", {});
    expect(events.length).toBe(countBefore); // no new events
  });
});

// ─── captureSnapshot ────────────────────────────────────────────────────────

describe("captureSnapshot", () => {
  it("deep clones state so mutations don't affect the snapshot", () => {
    const state = { nested: { value: 1 } };
    const snapshot = captureSnapshot(state);

    state.nested.value = 999;
    expect((snapshot.serialized as any).nested.value).toBe(1);
  });

  it("produces a valid SHA-256 hash", () => {
    const snapshot = captureSnapshot({ a: 1 });
    expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("identical states produce identical hashes", () => {
    const s1 = captureSnapshot({ b: 2, a: 1 });
    const s2 = captureSnapshot({ a: 1, b: 2 });
    expect(s1.hash).toBe(s2.hash);
  });
});

// ─── rollbackToSafe with a flagged entry ────────────────────────────────────

describe("rollbackToSafe with a problem", () => {
  it("rolls back to the flagged entry and restores state", async () => {
    const database: Record<string, { id: string; price: number }> = {
      acme: { id: "acme", price: 500 },
    };

    const critic = createRuleCritic([
      {
        name: "flag-deletions",
        check: ({ action }) => {
          if (action.tool === "dangerousAction") {
            return { verdict: "FLAGGED", reason: "Dangerous" };
          }
          return null;
        },
      },
    ]);

    const map = await MAP.load({ executor: "test", critic: "test" }, critic);
    map.registerTool("updatePrice", "update", z.object({ price: z.number() }), async ({ price }) => {
      database.acme.price = price;
      return { price };
    });
    map.registerTool("dangerousAction", "danger", z.object({}), async () => {
      database.acme.price = 0;
      return {};
    });
    map.connectState(
      () => JSON.parse(JSON.stringify(database)),
      (s) => Object.assign(database, s as any)
    );

    // Good action
    await map.execute("test", "updatePrice", { price: 299 });
    expect(database.acme.price).toBe(299);

    // Bad action (flagged)
    await map.execute("test", "dangerousAction", {});

    // rollbackToSafe should find the flagged entry and roll back
    const result = await map.rollbackToSafe();
    expect(result).not.toBeNull();
    expect(result!.entriesReverted).toBeGreaterThan(0);
    // State should be restored to before the dangerous action
    expect(database.acme.price).toBe(299);
  });
});

// ─── Custom Risk Classifier with Tiered Critic ─────────────────────────────

describe("custom risk classifier", () => {
  it("routes to the correct tier based on custom logic", async () => {
    const tiers: string[] = [];

    const critic = createTieredCritic({
      low: async () => { tiers.push("low"); return { verdict: "PASS" as const, reason: "ok" }; },
      medium: async () => { tiers.push("medium"); return { verdict: "PASS" as const, reason: "ok" }; },
      high: async () => { tiers.push("high"); return { verdict: "PASS" as const, reason: "ok" }; },
      classify: (action) => {
        // Custom: any amount > 10000 is high risk
        if ((action.input as any).amount > 10000) return "high";
        if (action.tool.startsWith("read")) return "low";
        return "medium";
      },
    });

    await critic({ goal: "test", action: { tool: "readData", input: {}, output: null }, stateBefore: {}, stateAfter: {}, previousActions: [] });
    await critic({ goal: "test", action: { tool: "transfer", input: { amount: 50000 }, output: null }, stateBefore: {}, stateAfter: {}, previousActions: [] });
    await critic({ goal: "test", action: { tool: "updateRecord", input: { amount: 100 }, output: null }, stateBefore: {}, stateAfter: {}, previousActions: [] });

    expect(tiers).toEqual(["low", "high", "medium"]);
  });
});

// ─── Full Learning Loop Integration ─────────────────────────────────────────

describe("learning loop integration", () => {
  it("learns from corrections and integrates with tiered critic", async () => {
    const database: Record<string, { price: number }> = {
      acme: { price: 500 },
    };

    // Critic that flags $0 prices
    const baseCritic = createRuleCritic([{
      name: "no-zero",
      check: ({ stateAfter }) => {
        const s = stateAfter as Record<string, { price: number }>;
        const bad = Object.values(s).find(c => c.price === 0);
        if (bad) return { verdict: "CORRECTED", reason: "Price $0", correction: { tool: "fix", input: { price: 299 } } };
        return null;
      },
    }]);

    const map = await MAP.load({ executor: "test", critic: "test" }, baseCritic);
    map.registerTool("setPrice", "set", z.object({ price: z.number() }), async ({ price }) => {
      database.acme.price = price;
      return { price };
    });
    map.registerTool("fix", "fix", z.object({ price: z.number() }), async ({ price }) => {
      database.acme.price = price;
      return { price };
    });
    map.connectState(
      () => JSON.parse(JSON.stringify(database)),
      (s) => Object.assign(database, s as any)
    );

    // Generate 3 corrections
    await map.execute("test", "setPrice", { price: 0 });
    database.acme.price = 500; // reset for next test
    await map.execute("test", "setPrice", { price: 0 });
    database.acme.price = 500;
    await map.execute("test", "setPrice", { price: 0 });

    // Learning engine analyzes the ledger
    const engine = new LearningEngine();
    const patterns = engine.analyzePatterns(map.getLedger());
    expect(patterns.length).toBeGreaterThan(0);

    const proposals = engine.proposeRules(map.getLedger(), 3);
    expect(proposals.length).toBeGreaterThan(0);

    // Human approves the rule
    proposals.forEach(r => engine.addProposedRule(r));
    engine.approveRule(proposals[0].id);

    // Learned rules now work as a critic
    const learnedCritic = engine.toRuleCritic();
    const result = await learnedCritic({
      goal: "test",
      action: { tool: "setPrice", input: { price: 0 }, output: null },
      stateBefore: {},
      stateAfter: {},
      previousActions: [],
    });
    expect(result.verdict).not.toBe("PASS");
    expect(result.reason).toContain("[learned]");

    // Integrate learned rules as the fast tier in a tiered critic
    // Use a custom classifier that routes "setPrice" to low tier
    const tieredCritic = createTieredCritic({
      low: learnedCritic,
      medium: baseCritic,
      high: baseCritic,
      classify: (action) => {
        if (action.tool === "setPrice") return "low";
        return "medium";
      },
    });

    // setPrice routed to low tier → learned rules fire (microseconds, no LLM)
    const tieredResult = await tieredCritic({
      goal: "test",
      action: { tool: "setPrice", input: { price: 0 }, output: null },
      stateBefore: {},
      stateAfter: {},
      previousActions: [],
    });
    expect(tieredResult.reason).toContain("[low]");
    expect(tieredResult.reason).toContain("[learned]");
  });
});

// ─── ESCALATE gates execution ───────────────────────────────────────────────

describe("ESCALATE strategy", () => {
  it("halts before executing the tool", async () => {
    let executed = false;
    const map = await MAP.load(
      { executor: "test", critic: "test" },
      createRuleCritic([])
    );

    const tool = defineEscalateTool({
      name: "wireTransfer",
      description: "Send wire",
      inputSchema: z.object({ amount: z.number() }),
      execute: async (input) => {
        executed = true; // Should NEVER be reached
        return { transferId: "tr_123" };
      },
      approver: "treasury@acme.com",
    });
    map.addTool(tool);
    map.connectState(() => ({}), () => {});

    const result = await map.execute("Send money", "wireTransfer", { amount: 50000 });

    expect(executed).toBe(false); // Tool was NOT executed
    expect(result.halted).toBe(true);
    expect(result.entry.critic.verdict).toBe("FLAGGED");
    expect(result.entry.action.output).toEqual({ pending: true, reason: "ESCALATE: awaiting human approval" });
  });
});

// ─── RESTORE capture is called ──────────────────────────────────────────────

describe("RESTORE strategy", () => {
  it("calls capture before tool execution", async () => {
    const calls: string[] = [];
    const map = await MAP.load(
      { executor: "test", critic: "test" },
      createRuleCritic([])
    );

    const tool = defineRestoreTool({
      name: "updateRecord",
      description: "Update a record",
      inputSchema: z.object({ id: z.string(), value: z.number() }),
      execute: async (input) => {
        calls.push("execute");
        return { updated: true };
      },
      capture: async (input) => {
        calls.push("capture");
        return { id: input.id, originalValue: 100 };
      },
      restore: async (captured) => {
        calls.push("restore");
      },
    });
    map.addTool(tool);
    map.connectState(() => ({}), () => {});

    await map.execute("test", "updateRecord", { id: "acme", value: 200 });

    expect(calls).toEqual(["capture", "execute"]);
  });

  it("calls restore on rollback to push state back to external system", async () => {
    const calls: string[] = [];
    let restoredWith: unknown = null;

    const map = await MAP.load(
      { executor: "test", critic: "test" },
      createRuleCritic([])
    );

    const tool = defineRestoreTool({
      name: "updateRecord",
      description: "Update a record",
      inputSchema: z.object({ id: z.string(), value: z.number() }),
      execute: async (input) => {
        calls.push("execute");
        return { updated: true };
      },
      capture: async (input) => {
        calls.push("capture");
        return { id: input.id, originalValue: 100 };
      },
      restore: async (captured) => {
        calls.push("restore");
        restoredWith = captured;
      },
    });
    map.addTool(tool);

    const state = { record: { id: "acme", value: 500 } };
    map.connectState(
      () => JSON.parse(JSON.stringify(state)),
      (s) => Object.assign(state, s as any)
    );

    // Execute a RESTORE tool
    await map.execute("test", "updateRecord", { id: "acme", value: 200 });
    expect(calls).toEqual(["capture", "execute"]);

    // Rollback — should call restore() with the captured state
    const ledger = map.getLedger();
    await map.rollbackTo(ledger[0].id);

    expect(calls).toEqual(["capture", "execute", "restore"]);
    expect(restoredWith).toEqual({ id: "acme", originalValue: 100 });
  });

  it("stores capturedState in the ledger entry", async () => {
    const map = await MAP.load(
      { executor: "test", critic: "test" },
      createRuleCritic([])
    );

    const tool = defineRestoreTool({
      name: "updateRecord",
      description: "Update",
      inputSchema: z.object({ id: z.string() }),
      execute: async () => ({ done: true }),
      capture: async (input) => ({ id: input.id, savedAt: "2026-01-01" }),
      restore: async () => {},
    });
    map.addTool(tool);
    map.connectState(() => ({}), () => {});

    const result = await map.execute("test", "updateRecord", { id: "acme" });
    expect(result.entry.action.capturedState).toEqual({ id: "acme", savedAt: "2026-01-01" });
  });
});
