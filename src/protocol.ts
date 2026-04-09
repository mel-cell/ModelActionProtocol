// =============================================================================
// MAP — Model Action Protocol
//
// The open standard for agent action provenance. Every autonomous agent action
// is logged as a LedgerEntry with cryptographic chaining, state snapshots,
// and critic verdicts. The ledger is append-only and tamper-evident.
//
// Design principles (from Claude Code architecture):
//   - Schema-driven: Zod schemas decouple agent from implementation
//   - Messages as state: the ledger IS the execution state
//   - Errors as feedback: failures feed back into the loop, never crash
// =============================================================================

import { z } from "zod";

// ─── Critic Verdicts ────────────────────────────────────────────────────────

export const CriticVerdict = z.enum([
  "PASS",       // Action is correct, no issues
  "CORRECTED",  // Action had an error, critic auto-fixed it
  "FLAGGED",    // Action is dangerous, requires human review
]);
export type CriticVerdict = z.infer<typeof CriticVerdict>;

// ─── Critic Cost Tracking ───────────────────────────────────────────────────

export const CriticCost = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  model: z.string(),
  latencyMs: z.number(),
  costUsd: z.number().optional(),
});
export type CriticCost = z.infer<typeof CriticCost>;

export const CriticResult = z.object({
  verdict: CriticVerdict,
  reason: z.string(),
  correction: z.object({
    tool: z.string(),
    input: z.record(z.string(), z.unknown()),
  }).optional(),
  cost: CriticCost.optional(),
});
export type CriticResult = z.infer<typeof CriticResult>;

// ─── Reversal Schema ────────────────────────────────────────────────────────
// Every MAP-compliant tool MUST declare how its actions can be reversed.
// This is the key innovation: rollback isn't just "restore a snapshot" —
// it's a typed strategy that matches how the real world works.
//
//   COMPENSATE — for systems that don't allow hard deletes (ERPs, accounting).
//                Maps a forward action to its compensating action.
//                Example: duplicate invoice → issue credit memo.
//
//   RESTORE    — for CRUD APIs that support state reversion.
//                Before every write, MAP forces a GET to capture state.
//                Rollback pushes the original state back via UPDATE.
//
//   ESCALATE   — for irreversible actions (wire transfers, emails, deploys).
//                MAP intercepts before execution, places the action in
//                "Pending" state, and routes to a human for approval.

export const ReversalStrategy = z.enum([
  "COMPENSATE",  // Dispatch a compensating action (e.g., credit memo for duplicate invoice)
  "RESTORE",     // Capture before-state via GET, rollback via PUT
  "ESCALATE",    // Require human approval before execution
]);
export type ReversalStrategy = z.infer<typeof ReversalStrategy>;

export const ReversalSchema = z.object({
  strategy: ReversalStrategy,
  /** For COMPENSATE: the tool + input that reverses this action */
  compensatingAction: z.object({
    tool: z.string(),
    inputMapping: z.record(z.string(), z.string()), // maps forward input fields → reverse input fields
  }).optional(),
  /** For RESTORE: the endpoint/method to capture before-state */
  captureMethod: z.string().optional(),
  /** For ESCALATE: who should approve (role, email, or group) */
  approver: z.string().optional(),
  /** Human-readable description of the reversal */
  description: z.string().optional(),
});
export type ReversalSchema = z.infer<typeof ReversalSchema>;

// ─── Action Record ──────────────────────────────────────────────────────────

export const ActionRecord = z.object({
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  output: z.unknown(),
  reversalStrategy: ReversalStrategy.optional(),
});
export type ActionRecord = z.infer<typeof ActionRecord>;

// ─── Multi-Agent Provenance (MAP Spec) ──────────────────────────────────────
// When multiple agents work simultaneously, provenance must track WHO did what,
// WHO authorized it, and WHO spawned whom. These types enable a single human
// to supervise a fleet of autonomous agents.

// Agent Identity — every agent in the system has a cryptographic identity
export interface AgentIdentity {
  /** Unique identifier for this agent instance */
  agentId: string;
  /** Organization or user that owns this agent */
  ownerId: string;
  /** Domain of the owner (e.g., "customer.com", "bank.com") */
  ownerDomain: string;
  /** What this agent is authorized to do */
  capabilities: string[];
  /** SHA-256 hash of the agent's auth credential */
  credentialHash: string;
}

// KYA (Know Your Agent) — cross-boundary authorization grants
// When Agent A asks Agent B to do something, the authorization is logged
// with scope, constraints, expiry, and delegation chain. This is how you
// answer "who authorized this agent to do that?" after the fact.
export interface AuthorizationGrant {
  /** Unique grant ID */
  id: string;
  /** When the grant was issued */
  timestamp: string;
  /** The agent requesting action (grantor) */
  grantor: AgentIdentity;
  /** The agent executing action (grantee) */
  grantee: AgentIdentity;
  /** Specific actions authorized (e.g., ["adjustBalance", "reclassifyTransaction"]) */
  scope: string[];
  /** Additional constraints (e.g., max amount, time window) */
  constraints: Record<string, unknown>;
  /** When this grant expires */
  expiresAt?: string;
  /** If delegated from another grant (delegation chain) */
  parentGrantId?: string;
  /** Whether this grant has been revoked */
  revoked?: boolean;
  /** SHA-256 hash of the grant for tamper-evidence */
  hash: string;
}

// Ephemeral Agent Lifecycle — tracks agent spawn trees
// When an agent spawns sub-agents (like Claude Code's subagent pattern),
// the lifecycle tracks the parent-child relationships, purpose, and
// termination. This is how you answer "which agents are still running
// and who spawned them?"
export interface AgentLifecycle {
  /** This agent's ID */
  agentId: string;
  /** Who spawned this agent (null for root agents) */
  parentAgentId?: string;
  /** When this agent was created */
  spawnedAt: string;
  /** When this agent terminated (null if still alive) */
  terminatedAt?: string;
  /** Why this agent was created */
  purpose: string;
  /** True for temporary sub-agents that should auto-terminate */
  isEphemeral: boolean;
  /** Sub-agents this agent spawned */
  childAgentIds: string[];
}

// ─── Ledger Entry ───────────────────────────────────────────────────────────
// Each entry chains to the previous via parentHash, forming a tamper-evident
// append-only log. Inspired by Claude Code's "messages as state" pattern —
// the full execution state is reconstructible from the ledger alone.
//
// Multi-agent fields enable a single ledger to track actions from multiple
// agents, with full lineage tracing back to the root agent.

export const LedgerEntryStatus = z.enum([
  "ACTIVE",        // Normal committed entry
  "ROLLED_BACK",   // Entry was reverted by a rollback
]);
export type LedgerEntryStatus = z.infer<typeof LedgerEntryStatus>;

export const ApprovalStatus = z.enum([
  "pending",    // Awaiting human review
  "approved",   // Human approved
  "rejected",   // Human rejected — rollback required
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const LedgerEntry = z.object({
  id: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  action: ActionRecord,
  stateBefore: z.string(),   // SHA-256 hash of state snapshot
  stateAfter: z.string(),    // SHA-256 hash of state snapshot
  snapshots: z.object({
    before: z.unknown(),     // Full serialized state
    after: z.unknown(),      // Full serialized state
  }),
  parentHash: z.string(),    // Previous entry's hash (genesis = "0")
  hash: z.string(),          // SHA-256(sequence + action + stateBefore + stateAfter + parentHash)
  critic: CriticResult,
  status: LedgerEntryStatus.default("ACTIVE"),
  // Approval (separate from status — clean separation of concerns)
  approval: ApprovalStatus.optional(),
  // Multi-agent provenance
  agentId: z.string().optional(),           // Which agent took this action
  parentEntryId: z.string().optional(),     // Links to upstream agent's entry
  lineage: z.array(z.string()).optional(),  // Ordered agentIds from root to current
  // Optimistic concurrency control for multi-agent writes
  stateVersion: z.number().optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

// ─── Tool Definition ────────────────────────────────────────────────────────
// Following Claude Code's schema-driven tool pattern: each tool declares its
// name, description, input schema, and execution function. The schema is used
// for validation AND can be exported as JSON for the agent's tool definitions.

export interface MAPTool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput) => Promise<TOutput>;
  /** How this tool's actions can be reversed — REQUIRED for MAP compliance */
  reversal?: ReversalSchema;
}

// ─── Session Config ─────────────────────────────────────────────────────────

export interface MAPConfig {
  /** Model for the executor agent (e.g., 'claude-sonnet-4.6') */
  executor: string;
  /** Model for the critic (e.g., 'claude-haiku-4.5') — cheap, fast */
  critic: string;
  /** Maximum actions before the session is force-stopped */
  maxActions?: number;
  /** Whether to auto-correct on CORRECTED verdicts (default: true) */
  autoCorrect?: boolean;
  /** Whether to pause on FLAGGED verdicts (default: true) */
  pauseOnFlag?: boolean;
  /** Custom state serializer (default: JSON.stringify) */
  serializeState?: (state: unknown) => string;
  /** Tags for AI Gateway cost attribution */
  tags?: string[];
}

// ─── Session Events ─────────────────────────────────────────────────────────
// Event-driven architecture for real-time UI updates. Follows Claude Code's
// pattern of state updates flowing through callbacks rather than polling.

export type MAPEvent =
  | { type: "action:start"; tool: string; input: unknown; agentId?: string }
  | { type: "action:complete"; entry: LedgerEntry }
  | { type: "critic:verdict"; entry: LedgerEntry }
  | { type: "correction:applied"; original: LedgerEntry; corrected: LedgerEntry }
  | { type: "flagged"; entry: LedgerEntry }
  | { type: "rollback:start"; targetId: string }
  | { type: "rollback:complete"; targetId: string; entriesReverted: number }
  | { type: "session:complete"; totalActions: number; totalCorrections: number; totalFlags: number }
  | { type: "agent:spawned"; lifecycle: AgentLifecycle }
  | { type: "agent:terminated"; agentId: string }
  | { type: "authorization:granted"; grant: AuthorizationGrant }
  | { type: "authorization:revoked"; grantId: string }
  | { type: "error"; error: Error };

export type MAPEventHandler = (event: MAPEvent) => void;

// ─── MAP Protocol Version ───────────────────────────────────────────────────

export const MAP_VERSION = "0.1.0";
export const MAP_PROTOCOL = "map" as const;
