// =============================================================================
// @model-action-protocol/core — Tests
//
// Verifies: ledger chaining, critic integration, rollback, chain verification
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { MAP } from "../map.js";
import { createRuleCritic } from "../critic.js";
import { verifyChain } from "../snapshot.js";
import type { MAPEvent, LedgerEntry } from "../protocol.js";

// ─── Test Database ──────────────────────────────────────────────────────────

interface Customer {
  id: string;
  name: string;
  plan: string;
  price: number;
  status: string;
}

let database: Record<string, Customer>;

function resetDatabase() {
  database = {
    acme: { id: "acme", name: "Acme Corp", plan: "enterprise", price: 500, status: "active" },
    globex: { id: "globex", name: "Globex Inc", plan: "enterprise", price: 500, status: "active" },
    initech: { id: "initech", name: "Initech", plan: "enterprise", price: 500, status: "active" },
    umbrella: { id: "umbrella", name: "Umbrella Corp", plan: "starter", price: 50, status: "active" },
  };
}

// ─── Test Critic ────────────────────────────────────────────────────────────

const testCritic = createRuleCritic([
  {
    name: "no-zero-prices",
    check: ({ stateAfter }) => {
      const state = stateAfter as Record<string, Customer>;
      const zeroPrice = Object.values(state).find((c) => c.price === 0);
      if (zeroPrice) {
        return {
          verdict: "CORRECTED",
          reason: `${zeroPrice.name} price was set to $0`,
          correction: {
            tool: "updatePrice",
            input: { customerId: zeroPrice.id, price: 299 },
          },
        };
      }
      return null;
    },
  },
  {
    name: "no-deletions",
    check: ({ action, stateBefore, stateAfter }) => {
      if (action.tool === "deleteCustomer") {
        return {
          verdict: "FLAGGED",
          reason: `Deletion of customer "${action.input.customerId}" is a destructive action requiring human review`,
        };
      }
      return null;
    },
  },
]);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("@model-action-protocol/core", () => {
  let map: MAP;

  beforeEach(() => {
    resetDatabase();
    map = new MAP(
      { executor: "test/executor", critic: "test/critic" },
      testCritic
    );

    // Register tools
    map.registerTool(
      "updatePrice",
      "Update a customer's price",
      z.object({ customerId: z.string(), price: z.number() }),
      async ({ customerId, price }) => {
        database[customerId].price = price;
        return { updated: customerId, newPrice: price };
      }
    );

    map.registerTool(
      "deleteCustomer",
      "Delete a customer record",
      z.object({ customerId: z.string() }),
      async ({ customerId }) => {
        const customer = database[customerId];
        delete database[customerId];
        return { deleted: customerId, name: customer?.name };
      }
    );

    // Connect state
    map.connectState(
      () => JSON.parse(JSON.stringify(database)),
      (state) => {
        database = state as Record<string, Customer>;
      }
    );
  });

  // ─── Ledger Chaining ────────────────────────────────────────────────────

  it("creates a valid hash chain across multiple actions", async () => {
    await map.execute("Update pricing", "updatePrice", { customerId: "acme", price: 299 });
    await map.execute("Update pricing", "updatePrice", { customerId: "globex", price: 399 });

    const ledger = map.getLedger();
    expect(ledger.length).toBe(2);
    expect(ledger[0].parentHash).toBe("0".repeat(64));
    expect(ledger[1].parentHash).toBe(ledger[0].hash);

    const integrity = map.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("detects tampered entries", async () => {
    await map.execute("Update pricing", "updatePrice", { customerId: "acme", price: 299 });
    await map.execute("Update pricing", "updatePrice", { customerId: "globex", price: 399 });

    // Tamper with the ledger entries directly
    const entries = map.getLedger() as LedgerEntry[];
    const tampered = entries.map((e, i) => ({
      ...e,
      hash: i === 0 ? "tampered_hash" : e.hash,
    }));

    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.corruptedAt).toBe(0);
  });

  // ─── Critic Integration ─────────────────────────────────────────────────

  it("passes valid actions through the critic", async () => {
    const result = await map.execute("Update pricing", "updatePrice", {
      customerId: "acme",
      price: 299,
    });

    expect(result.entry.critic.verdict).toBe("PASS");
    expect(database.acme.price).toBe(299);
  });

  it("auto-corrects when critic detects an error", async () => {
    const result = await map.execute("Update pricing", "updatePrice", {
      customerId: "acme",
      price: 0, // This should trigger the no-zero-prices rule
    });

    // Should have been corrected
    expect(result.corrected).toBe(true);
    expect(database.acme.price).toBe(299); // Corrected to 299

    // Ledger should have 2 entries: the bad action + the correction
    const ledger = map.getLedger();
    expect(ledger.length).toBe(2);
    expect(ledger[0].critic.verdict).toBe("CORRECTED");
    expect(ledger[1].critic.verdict).toBe("PASS");
  });

  it("flags dangerous actions and halts execution", async () => {
    const result = await map.execute("Clean up", "deleteCustomer", {
      customerId: "acme",
    });

    expect(result.entry.critic.verdict).toBe("FLAGGED");
    expect(result.halted).toBe(true);
  });

  // ─── Rollback ───────────────────────────────────────────────────────────

  it("rolls back to a previous state", async () => {
    // Execute two valid updates
    const first = await map.execute("Update pricing", "updatePrice", {
      customerId: "acme",
      price: 299,
    });
    await map.execute("Update pricing", "updatePrice", {
      customerId: "globex",
      price: 399,
    });

    expect(database.acme.price).toBe(299);
    expect(database.globex.price).toBe(399);

    // Rollback to before the second update
    const ledger = map.getLedger();
    map.rollbackTo(ledger[1].id);

    // Acme should still be 299 (from first action), Globex should be back to 500
    expect(database.acme.price).toBe(299);
    expect(database.globex.price).toBe(500);
  });

  it("logs the rollback itself to the ledger", async () => {
    await map.execute("Update pricing", "updatePrice", { customerId: "acme", price: 299 });
    const ledger = map.getLedger();

    map.rollbackTo(ledger[0].id);

    const updatedLedger = map.getLedger();
    const rollbackEntry = updatedLedger[updatedLedger.length - 1];
    expect(rollbackEntry.action.tool).toBe("ROLLBACK");
    expect(rollbackEntry.status).toBe("ACTIVE");
  });

  // ─── Export ─────────────────────────────────────────────────────────────

  it("exports a complete audit-ready ledger", async () => {
    await map.execute("Update pricing", "updatePrice", { customerId: "acme", price: 299 });

    const exported = map.exportLedger();
    expect(exported.protocol).toBe("map");
    expect(exported.version).toBe("0.1.0");
    expect(exported.entries.length).toBe(1);
    expect(exported.stats.total).toBe(1);
    expect(exported.stats.committed).toBe(1);
  });

  // ─── Events ─────────────────────────────────────────────────────────────

  it("emits events for real-time UI updates", async () => {
    const events: MAPEvent[] = [];
    map.on((event) => events.push(event));

    await map.execute("Update pricing", "updatePrice", { customerId: "acme", price: 299 });

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("action:start");
    expect(eventTypes).toContain("action:complete");
    expect(eventTypes).toContain("critic:verdict");
  });

  // ─── Sequence Execution ─────────────────────────────────────────────────

  it("executes a sequence of actions and reports stats", async () => {
    const result = await map.run("Migrate pricing", [
      { tool: "updatePrice", input: { customerId: "acme", price: 299 } },
      { tool: "updatePrice", input: { customerId: "globex", price: 399 } },
      { tool: "updatePrice", input: { customerId: "initech", price: 0 } }, // Will be corrected
    ]);

    expect(result.actionsExecuted).toBe(3);
    expect(result.correctionsApplied).toBe(1);
    expect(database.acme.price).toBe(299);
    expect(database.globex.price).toBe(399);
    expect(database.initech.price).toBe(299); // Corrected from 0
  });
});
