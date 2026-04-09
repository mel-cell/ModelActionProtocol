# Changelog

## 0.1.0 (2026-04-09)

Initial release of `@model-action-protocol/core`.

### Features

- **Cryptographic Provenance Ledger** — SHA-256 hash-chained, append-only action log with full state snapshots
- **Self-Healing Critic Loop** — Tiered model routing with PASS / CORRECTED / FLAGGED verdicts
- **Reversal Schema** — COMPENSATE, RESTORE, and ESCALATE strategies for typed rollback
- **State Rollback** — One-click revert to any prior ledger entry, rollback logged as provenance
- **Multi-Agent Provenance (KYA)** — Agent identity, authorization grants, ephemeral lifecycle tracking
- **Human-on-the-Loop Approval** — Pending/approved/rejected workflow for flagged actions
- **Learning Engine** — Rule extraction, fine-tuning export, and agent memory from correction history
- **Tool Builder** — `defineTool`, `defineRestoreTool`, `defineCompensateTool`, `defineEscalateTool` helpers
- **Real-Time Events** — Event-driven architecture for UI integration
