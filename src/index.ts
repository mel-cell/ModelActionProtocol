// =============================================================================
// @model-action-protocol/core — MAP (Model Action Protocol)
//
// Cryptographic provenance, self-healing, and state rollback
// for autonomous AI agents.
//
// MCP gave Claude the hands. MAP gives Claude the receipt.
// =============================================================================

// Main class
export { MAP } from "./map.js";

// Ledger
export { Ledger } from "./ledger.js";
export type { LedgerStore } from "./store.js";
export type { PostgresLedgerStore } from "./adapters/postgres.js";

// Critic
export { createLLMCritic, createRuleCritic, createTieredCritic, defaultRiskClassifier } from "./critic.js";
export type { CriticFunction, RiskTier, RiskClassifier } from "./critic.js";

// Rollback
export { executeRollback, findLastProblem, findSafePoint } from "./rollback.js";

// Snapshot & Hashing
export { sha256, serializeState, captureSnapshot, computeEntryHash, verifyChain } from "./snapshot.js";

// Executor
export { executeAction, executeSequence } from "./executor.js";

// Protocol types
export type {
  LedgerEntry,
  LedgerEntryStatus,
  ApprovalStatus,
  ActionRecord,
  CriticResult,
  CriticVerdict,
  CriticCost,
  ReversalStrategy,
  ReversalSchema,
  AgentIdentity,
  AuthorizationGrant,
  AgentLifecycle,
  MAPTool,
  MAPConfig,
  MAPEvent,
  MAPEventHandler,
} from "./protocol.js";

export { MAP_VERSION, MAP_PROTOCOL } from "./protocol.js";

// Pre-built tool helpers
export { defineTool, defineRestoreTool, defineCompensateTool, defineEscalateTool } from "./tool-builder.js";

// Learning Engine — the ledger IS the training data
export { LearningEngine } from "./learning.js";
export type { LearnedRule, CorrectionPattern } from "./learning.js";
