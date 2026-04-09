# MAP Roadmap

## v0.1.0 (current)

The protocol foundation: cryptographic ledger, self-healing critic, state rollback, reversal schemas, tiered review, learning engine. Single-agent provenance with multi-agent type definitions.

### Known Limitations
- In-memory ledger only (no persistent storage adapter yet)
- RESTORE `capture()` runs before execution; `restore()` on rollback restores in-memory snapshots, not external systems via the tool's restore function
- Multi-agent types (AgentIdentity, KYA, AgentLifecycle) are defined but not enforced at runtime
- `autoCorrect` defaults to `true` — consider setting to `false` in production until your critic rules are validated
- No concurrency protection — do not call `execute()` concurrently without external synchronization

## v0.2.0

- **Persistent storage adapter** — pluggable `LedgerStore` interface with SQLite and PostgreSQL implementations
- **RESTORE rollback dispatch** — rollback calls `tool.restore()` for RESTORE-strategy tools, pushing state back to external systems
- **Session binding** — session nonce in every entry hash to prevent fork/replay attacks
- **Concurrency** — mutex on `executeAction` or optimistic concurrency via `stateVersion`
- **Approval API** — `map.approve(entryId)` and `map.reject(entryId)` for human-in-the-loop workflows

## v0.3.0

- **Multi-agent runtime** — enforce AgentIdentity, validate AuthorizationGrants, track AgentLifecycle at runtime (not just types)
- **PII redaction** — configurable field-level redaction for ledger export and fine-tuning export
- **Audit-only export mode** — hashes + metadata without full state snapshots
- **External integrity proof** — signed chain heads for non-repudiation

## v1.0.0

- **Pre-built tool packages** — `@model-action-protocol/tools-stripe`, `tools-salesforce`, `tools-netsuite`
- **`npx map wrap my-mcp-server`** — zero-config wrapping of existing MCP tools with auto-inferred reversal schemas
- **Compliance rule packs** — SOX, HIPAA, PCI-DSS pre-built critic rules
- **Encryption at rest** — optional envelope encryption for snapshots and exports

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get involved.
