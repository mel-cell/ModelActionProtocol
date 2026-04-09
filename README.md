# @model-action-protocol/core

**MAP (Model Action Protocol) — Cryptographic provenance, self-healing, and state rollback for autonomous AI agents.**

MCP gave Claude the hands. MAP gives Claude the receipt.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-10%2F10-brightgreen.svg)]()

---

## The Problem

AI agents are entering Phase 3: **autonomous execution.** They schedule reasoning, call tools, execute multi-step processes, and verify their own results — all without a human in the loop.

But there's no liability shield.

| Phase | Era | Who's Responsible? |
|-------|-----|-------------------|
| **Phase 1: Chatbots** (Nov 2022) | Model generates answers from prompts | Human — they read and act on the output |
| **Phase 2: Reasoning** (Sep 2024) | Model reasons before answering, reduces errors | Human — still driving step by step |
| **Phase 3: Agents** (2025-2026) | Agent executes autonomously, verifies its own work | **Nobody** — the human is abstracted away |

When an agent deletes a production database, sends the wrong email, or misconfigures infrastructure — who's accountable? How do you prove what happened? How do you undo it?

And when **fleets** of agents work simultaneously — who authorized what, who spawned whom, and which agent broke which thing?

**MAP is the OS-level liability shield for autonomous agents.**

---

## What It Does

### 1. Cryptographic Provenance Ledger

Every agent action is logged to an append-only, SHA-256 hash-chained ledger:
- Full state snapshots before and after every action
- Tamper-evident — change one entry, all subsequent hashes break
- Exportable as JSON for audit compliance
- Chain verification in one call

### 2. Self-Healing Critic Loop

After every action, a fast critic model reviews the result:
- **PASS** — Action is correct, continue
- **CORRECTED** — Error detected, auto-fixed, both logged
- **FLAGGED** — Dangerous action, execution halts for human review

Uses tiered model routing: expensive model executes, cheap model critiques.

### 3. Reversal Schema (COMPENSATE / RESTORE / ESCALATE)

Every MAP-compliant tool declares how its actions can be reversed:

| Strategy | When | How Rollback Works |
|----------|------|-------------------|
| **COMPENSATE** | Systems that don't allow hard deletes (ERPs, accounting) | Dispatch a compensating action (e.g., credit memo for duplicate invoice) |
| **RESTORE** | CRUD APIs with GET + PUT | Auto-capture state before write, push original state back on rollback |
| **ESCALATE** | Irreversible actions (wire transfers, emails, deploys) | Intercept before execution, require human approval |

### 4. State Rollback

One-click revert to any prior point in the ledger:
- The rollback itself is logged to the provenance chain
- Rollback doesn't delete history — it preserves the full chain and adds a revert entry
- Surgical rollback: revert one agent's action without affecting others

### 5. Multi-Agent Provenance (KYA — Know Your Agent)

When fleets of agents work simultaneously, MAP tracks everything:

**Agent Identity** — every agent has a cryptographic identity:
```typescript
{
  agentId: string;
  ownerId: string;           // org/user that owns this agent
  ownerDomain: string;       // e.g., "customer.com"
  capabilities: string[];    // what this agent can do
  credentialHash: string;    // SHA-256 of auth credential
}
```

**Authorization Grants** — cross-boundary trust:
```typescript
{
  grantor: AgentIdentity;    // Agent A (requesting)
  grantee: AgentIdentity;    // Agent B (executing)
  scope: string[];           // specific actions authorized
  constraints: {};           // e.g., max amount, time window
  expiresAt?: string;        // when this grant expires
  parentGrantId?: string;    // delegation chain
  hash: string;              // tamper-evident
}
```

**Ephemeral Agent Lifecycle** — spawn tree tracking:
```typescript
{
  agentId: string;
  parentAgentId?: string;    // who spawned this agent
  spawnedAt: string;
  terminatedAt?: string;     // null if still alive
  purpose: string;           // why this agent exists
  isEphemeral: boolean;      // auto-terminate when done
  childAgentIds: string[];   // sub-agents spawned
}
```

Every ledger entry carries `agentId`, `parentEntryId`, and `lineage[]` — the full chain from root agent to the action.

### 6. Human-on-the-Loop Approval

Corrections can require human sign-off before proceeding:
- `pending` → action awaits review
- `approved` → human confirmed, logged to chain
- `rejected` → human rejected, rollback required

Approval is a separate concern from entry status — clean separation.

---

## MCP + MAP: The Complete Picture

| | MCP | MAP |
|---|---|---|
| **Direction** | Input — what the agent can see | Output — what the agent did |
| **Purpose** | Capability | Accountability |
| **Analogy** | Git (version control) | GitHub (collaboration + audit) |

MCP defines how agents read the world. MAP defines how agents safely write to it. Together they complete the picture for enterprise-grade autonomous agents.

---

## Installation

```bash
npm install @model-action-protocol/core
```

**Requirements:** Node.js 20+, TypeScript 5.7+

---

## Quick Start

```typescript
import { MAP, createRuleCritic } from '@model-action-protocol/core';
import { z } from 'zod';

// Your state
const database: Record<string, any> = {
  acme:   { id: "acme", name: "Acme Corp", price: 500 },
  globex: { id: "globex", name: "Globex Inc", price: 500 },
};

// 1. Create a critic
const critic = createRuleCritic([
  {
    name: 'no-zero-prices',
    check: ({ stateAfter }) => {
      const state = stateAfter as Record<string, any>;
      const bad = Object.values(state).find((c) => c.price === 0);
      if (bad) {
        return {
          verdict: 'CORRECTED',
          reason: `${bad.name} price was set to $0`,
          correction: { tool: 'updatePrice', input: { customerId: bad.id, price: 299 } },
        };
      }
      return null;
    },
  },
]);

// 2. Initialize MAP
const map = new MAP(
  { executor: 'claude-sonnet-4.6', critic: 'claude-haiku-4.5' },
  critic
);

// 3. Register tools
map.registerTool(
  'updatePrice', 'Update a customer price',
  z.object({ customerId: z.string(), price: z.number() }),
  async ({ customerId, price }) => {
    database[customerId].price = price;
    return { updated: customerId, newPrice: price };
  }
);

// 4. Connect state
map.connectState(
  () => JSON.parse(JSON.stringify(database)),
  (state) => Object.assign(database, state),
);

// 5. Execute with full provenance
await map.execute('Migrate pricing', 'updatePrice', { customerId: 'acme', price: 299 });

// 6. Rollback if needed
const ledger = map.getLedger();
map.rollbackTo(ledger[0].id);

// 7. Export for audit
const audit = map.exportLedger();
// → { protocol: 'map', version: '0.1.0', entries: [...], stats: {...} }

// 8. Verify chain integrity
map.verifyIntegrity(); // → { valid: true }
```

---

## The Paved Path: Pre-Built Tool Packages

Instead of writing reversal schemas from scratch, use pre-built MAP-compliant tools:

```typescript
// Drop in Stripe tools — provenance comes for free
import { stripeTools } from '@model-action-protocol/tools-stripe';
stripeTools.forEach(tool => map.addTool(tool));
```

Build tools with typed reversal strategies:

```typescript
import { defineRestoreTool, defineCompensateTool, defineEscalateTool } from '@model-action-protocol/core';

// RESTORE: auto-capture state before write, restore on rollback
const updateCustomer = defineRestoreTool({
  name: 'updateCustomer', description: 'Update customer record',
  inputSchema: z.object({ id: z.string(), email: z.string() }),
  execute: async (input) => api.updateCustomer(input),
  capture: async (input) => api.getCustomer(input.id),
  restore: async (captured) => api.updateCustomer(captured),
});

// COMPENSATE: map forward action to compensating action
const chargeCard = defineCompensateTool({
  name: 'chargeCard', description: 'Charge a credit card',
  inputSchema: z.object({ amount: z.number() }),
  execute: async (input) => stripe.charges.create(input),
  compensate: async (input, output) => stripe.refunds.create({ charge: output.id }),
});

// ESCALATE: require human approval for irreversible actions
const wireTransfer = defineEscalateTool({
  name: 'wireTransfer', description: 'Send a wire transfer',
  inputSchema: z.object({ amount: z.number(), to: z.string() }),
  execute: async (input) => bank.sendWire(input),
  approver: 'treasury@company.com',
});
```

**Planned tool packages:**
- `@model-action-protocol/tools-stripe` — payments, refunds, subscriptions (example included)
- `@model-action-protocol/tools-salesforce` — CRM operations
- `@model-action-protocol/tools-netsuite` — ERP/GL operations
- `@model-action-protocol/tools-hubspot` — marketing automation
- `@model-action-protocol/tools-aws` — infrastructure operations

---

## Using an LLM Critic (Production)

```typescript
import { MAP, createLLMCritic } from '@model-action-protocol/core';
import { generateText } from 'ai';

const critic = createLLMCritic({
  model: 'claude-haiku-4.5',
  generateText,
});

const map = new MAP(
  { executor: 'claude-sonnet-4.6', critic: 'claude-haiku-4.5' },
  critic
);
```

---

## Learning Engine — The Ledger IS the Training Data

Every CORRECTED verdict, every FLAGGED action, every human Approve/Reject decision is permanently logged with full context. Over time, this becomes a dataset of "mistakes this organization's agents make" and "how humans want them corrected."

### Level 1: Rule Extraction

After N identical corrections, the system proposes a new deterministic rule. No LLM needed for that check anymore — it becomes a microsecond gate.

```typescript
import { LearningEngine } from '@model-action-protocol/core';

const engine = new LearningEngine();

// Analyze the ledger for repeated correction patterns
const patterns = engine.analyzePatterns(map.getLedger());
// → [{ tool: "reclassifyTransaction", count: 5, summary: "CORRECTED: SOX violation..." }]

// Propose rules from patterns observed 3+ times
const proposals = engine.proposeRules(map.getLedger(), 3);
// → [{ id: "rule_corrected:reclassify...", description: "Auto-proposed: ...", approved: false }]

// Human reviews and approves the rule
proposals.forEach(r => engine.addProposedRule(r));
engine.approveRule(proposals[0].id);

// Use learned rules as the fast tier in the tiered critic
const learnedCritic = engine.toRuleCritic();

// Plug into tiered critic — learned rules run first (microseconds),
// LLM only fires for patterns the rules haven't seen yet
import { createTieredCritic } from '@model-action-protocol/core';

const tieredCritic = createTieredCritic({
  low: learnedCritic,                                                  // μs — learned rules
  medium: createLLMCritic({ model: 'claude-haiku-4.5', generateText }), // 200ms
  high: createLLMCritic({ model: 'claude-sonnet-4.6', generateText }),  // 1-2s
});
```

The system gets cheaper and faster over time. Every correction that becomes a rule is one fewer LLM call.

### Level 2: Critic Fine-Tuning

Export the corpus of corrections with human decisions as structured training data:

```typescript
const trainingData = engine.exportFineTuningData(map.getLedger());
// → [{
//   input: { action, stateBefore, stateAfter },
//   output: { verdict: "CORRECTED", reason: "SOX violation...", correction: {...} },
//   humanApproval: "approved"
// }]
```

Fine-tune the Critic model on your organization's specific error patterns. The Critic doesn't just know general compliance — it knows YOUR compliance.

### Level 3: Agent Self-Improvement

Give agents their own correction history so they stop repeating mistakes:

```typescript
const memory = engine.exportAgentMemory(map.getLedger(), 'agent-compliance-checker');
// → [{
//   tool: "closeAccount",
//   whatHappened: "Called closeAccount with { accountId: '1200-004' }",
//   verdict: "FLAGGED",
//   lesson: "This action was FLAGGED and required human review: regulatory hold violation.
//            Do not attempt this without explicit approval."
// }]

// Inject into agent's system prompt as learned context
const agentPrompt = `
  You are a compliance agent. Here are lessons from your past actions:
  ${memory.map(m => `- ${m.lesson}`).join('\n')}
`;
```

**Key design principle:** The learning engine reads from the ledger, never modifies it. Proposed rules require human approval before activating. The human stays on the loop even for the learning system.

### Data Privacy

**All learning is local to your organization.** A trust protocol cannot undermine trust.

| Level | Where Data Lives | Shared Across Orgs? | Used for Base Model Training? |
|-------|-----------------|--------------------|-----------------------------|
| **Rule extraction** | Your environment | No | No |
| **Critic fine-tuning** | Your private fine-tuned model | No | No |
| **Agent memory** | Your agent's prompt context | No | No |

- Level 2 fine-tuning is **explicitly opt-in** — you export the data and fine-tune on your terms
- Fine-tuned models are **scoped to your organization** — never cross-pollinated
- MAP does not transmit, aggregate, or share learning data between organizations

---

## Real-Time Events

```typescript
map.on((event) => {
  switch (event.type) {
    case 'action:start':       // Before tool execution
    case 'action:complete':    // After execution + logging
    case 'critic:verdict':     // After critic review
    case 'correction:applied': // After auto-correction
    case 'flagged':            // Dangerous action detected
    case 'rollback:start':     // Before rollback
    case 'rollback:complete':  // After rollback
    case 'session:complete':   // Sequence finished
    case 'agent:spawned':      // New agent in the fleet
    case 'agent:terminated':   // Agent finished its work
    case 'authorization:granted': // KYA grant issued
    case 'authorization:revoked': // KYA grant revoked
    case 'error':              // Unrecoverable error
  }
});
```

---

## API Reference

### `new MAP(config, critic)`

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `executor` | `string` | required | Model for the executor agent |
| `critic` | `string` | required | Model for the critic (cheap, fast) |
| `maxActions` | `number` | `50` | Max actions before force-stop |
| `autoCorrect` | `boolean` | `true` | Auto-apply CORRECTED fixes |
| `pauseOnFlag` | `boolean` | `true` | Halt execution on FLAGGED |
| `serializeState` | `fn` | `JSON.stringify` | Custom state serializer |
| `tags` | `string[]` | `[]` | AI Gateway cost attribution tags |

### Methods

| Method | Description |
|--------|-------------|
| `registerTool(name, desc, schema, fn)` | Register a tool with Zod schema |
| `addTool(tool)` | Register a pre-built MAPTool |
| `connectState(getState, setState)` | Connect to your environment |
| `execute(goal, tool, input)` | Execute one action with full provenance |
| `run(goal, actions[])` | Execute a sequence |
| `rollbackTo(entryId)` | Revert to a specific point |
| `rollbackToSafe()` | Revert to last known good state |
| `getLedger()` | Get all entries |
| `exportLedger()` | Export audit-ready JSON |
| `verifyIntegrity()` | Verify hash chain |
| `getStats()` | Session statistics |
| `on(handler)` | Subscribe to events |

### Ledger Entry Format

```typescript
{
  id: string;                    // UUID
  sequence: number;               // Position in chain
  timestamp: string;              // ISO 8601
  action: {
    tool: string;
    input: Record<string, unknown>;
    output: unknown;
    reversalStrategy?: "COMPENSATE" | "RESTORE" | "ESCALATE";
  };
  stateBefore: string;            // SHA-256 hash
  stateAfter: string;             // SHA-256 hash
  snapshots: { before, after };   // Full serialized state
  parentHash: string;             // Previous entry's hash
  hash: string;                   // SHA-256 of this entry
  critic: {
    verdict: "PASS" | "CORRECTED" | "FLAGGED";
    reason: string;
    correction?: { tool, input };
    cost?: { inputTokens, outputTokens, model, latencyMs, costUsd };
  };
  status: "ACTIVE" | "ROLLED_BACK";
  approval?: "pending" | "approved" | "rejected";
  // Multi-agent provenance
  agentId?: string;               // Which agent acted
  parentEntryId?: string;         // Upstream agent's entry
  lineage?: string[];             // Root → current agent chain
  stateVersion?: number;          // Optimistic concurrency
}
```

---

## Architecture

```
Human Supervisor (one person, many agents)
    │
    ▼
┌──────────────────────────────────────────────────┐
│               @model-action-protocol/core                 │
│                                                  │
│  ┌──────────┐  ┌────────┐  ┌────────────────┐   │
│  │ Executor │→ │ Critic │→ │    Ledger      │   │
│  │ Harness  │  │ (fast) │  │ (SHA-256 chain)│   │
│  └──────────┘  └────────┘  └────────────────┘   │
│       │                          │               │
│  ┌──────────┐  ┌────────────────┐│               │
│  │ Rollback │  │ KYA (Know Your ││               │
│  │ Engine   │  │    Agent)      ││               │
│  └──────────┘  └────────────────┘│               │
│                                  │               │
│  ┌──────────────────────────────┐│               │
│  │  Agent Lifecycle Tracking    ││               │
│  │  (spawn trees, ephemeral)    ││               │
│  └──────────────────────────────┘│               │
└──────────────────────────────────────────────────┘
    │              │              │
    ▼              ▼              ▼
  Agent A      Agent B       Agent C
 (Stripe)    (Salesforce)   (NetSuite)
```

---

## Design Principles

| Principle | How MAP Applies It |
|-----------|---------------------|
| **Messages as state** | The ledger IS the execution state |
| **Errors as feedback** | Critic failures feed back, never crash |
| **Schema-driven tools** | Zod schemas validate before execution |
| **Tiered model routing** | Expensive execution + cheap critique |
| **Append-only history** | Rollback adds a revert entry, never deletes |
| **Sub-agents as tool calls** | Agent spawns tracked with full lineage |

---

## The MAP Protocol

MAP (Model Action Protocol) is an open standard for agent action provenance.

**MCP** standardized how agents use tools (inputs).
**MAP** standardizes how agents prove what they did (outputs).

The strategy:
1. Open-source the protocol → every agent framework adopts it
2. Hand it to regulatory agencies → system of record for agent provenance
3. Commoditize the trust layer → build native zero-latency rollback into agent frameworks

---

## Testing

```bash
npm test
```

10 tests covering: ledger chaining, tamper detection, critic integration (PASS/CORRECTED/FLAGGED), auto-correction, state rollback, provenance of undo, audit export, event emission, sequence execution.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute to this project.

---

## License

MIT — by [deadpxl](https://deadpxl.studio)
