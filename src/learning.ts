// =============================================================================
// MAP Learning Engine — The ledger IS the training data
//
// Every CORRECTED verdict, every FLAGGED action, every human Approve/Reject
// is permanently logged with full context. Over time, this becomes a dataset
// of "mistakes this organization's agents make" and "how humans want them
// corrected."
//
// Three levels of learning:
//
//   1. Rule Extraction — After N identical corrections, propose a new
//      deterministic rule. No LLM needed anymore for that check.
//
//   2. Critic Fine-Tuning — The corpus of CORRECTED/FLAGGED entries with
//      human resolutions becomes fine-tuning data for the Critic model.
//
//   3. Agent Improvement — The agent learns from its own correction history.
//      "Last time I tried X, it was FLAGGED. Don't attempt that."
//
// The learning engine reads from the ledger. It never modifies it.
// New rules are proposals — a human must approve before they activate.
//
// ─── DATA PRIVACY ──────────────────────────────────────────────────────────
//
// ALL LEARNING IS LOCAL TO YOUR ORGANIZATION.
//
//   - Level 1 (rules): Deterministic rules derived from your ledger.
//     No data leaves your environment. Rules run locally.
//
//   - Level 2 (fine-tuning): Exports structured training data for YOU to
//     fine-tune YOUR private model. The fine-tuned model is scoped to your
//     org. No data is shared across organizations. No data is used for
//     base model training. Fine-tuning is explicitly opt-in.
//
//   - Level 3 (agent memory): Correction history injected into agent
//     prompts at runtime. Stays in your agent's context window.
//
// MAP does not transmit, aggregate, or cross-pollinate learning data
// between organizations. A trust protocol cannot undermine trust.
// =============================================================================

import type { LedgerEntry, ActionRecord } from "./protocol.js";
import type { CriticFunction } from "./critic.js";
import { sha256 } from "./snapshot.js";

// ─── Learned Rule ───────────────────────────────────────────────────────────

export interface LearnedRule {
  /** Unique rule ID */
  id: string;
  /** Human-readable description of what this rule catches */
  description: string;
  /** The tool this rule applies to */
  tool: string;
  /** The condition that triggers this rule (expressed as a check function) */
  condition: (action: ActionRecord, state: unknown) => boolean;
  /** What verdict to return when triggered */
  verdict: "CORRECTED" | "FLAGGED";
  /** The correction to apply (for CORRECTED rules) */
  correction?: { tool: string; input: Record<string, unknown> };
  /** How many times this pattern was observed before the rule was proposed */
  observedCount: number;
  /** Whether a human has approved this rule */
  approved: boolean;
  /** When this rule was proposed */
  proposedAt: string;
  /** When this rule was approved (if approved) */
  approvedAt?: string;
}

// ─── Correction Pattern ─────────────────────────────────────────────────────

export interface CorrectionPattern {
  /** The tool that was corrected */
  tool: string;
  /** Fingerprint of the correction type (hashed from verdict + tool + reason keywords) */
  fingerprint: string;
  /** Human-readable summary of the pattern */
  summary: string;
  /** Number of times this exact pattern has been observed */
  count: number;
  /** The entries that match this pattern */
  entryIds: string[];
  /** The most common correction applied */
  typicalCorrection?: { tool: string; input: Record<string, unknown> };
  /** The most common reason given by the critic */
  typicalReason: string;
}

// ─── Learning Engine ────────────────────────────────────────────────────────

export class LearningEngine {
  private rules: LearnedRule[] = [];
  private patterns: Map<string, CorrectionPattern> = new Map();

  /**
   * Analyze the ledger and extract correction patterns.
   * Call this after a session completes or on a schedule.
   */
  analyzePatterns(entries: readonly LedgerEntry[]): CorrectionPattern[] {
    this.patterns.clear();

    const corrections = entries.filter(
      (e) => e.critic.verdict === "CORRECTED" || e.critic.verdict === "FLAGGED"
    );

    for (const entry of corrections) {
      const fingerprint = this.computeFingerprint(entry);
      const existing = this.patterns.get(fingerprint);

      if (existing) {
        existing.count++;
        existing.entryIds.push(entry.id);
      } else {
        this.patterns.set(fingerprint, {
          tool: entry.action.tool,
          fingerprint,
          summary: `${entry.critic.verdict}: ${entry.action.tool} — ${entry.critic.reason}`,
          count: 1,
          entryIds: [entry.id],
          typicalCorrection: entry.critic.correction
            ? { tool: entry.critic.correction.tool, input: entry.critic.correction.input }
            : undefined,
          typicalReason: entry.critic.reason,
        });
      }
    }

    return Array.from(this.patterns.values());
  }

  /**
   * Propose new deterministic rules based on repeated correction patterns.
   * Only patterns observed N+ times are proposed (default: 3).
   *
   * Level 1 Learning: rule extraction.
   * "After N identical corrections, the system proposes a new deterministic
   * rule for the Critic. No LLM needed for that check anymore."
   */
  proposeRules(
    entries: readonly LedgerEntry[],
    threshold: number = 3
  ): LearnedRule[] {
    const patterns = this.analyzePatterns(entries);
    const proposals: LearnedRule[] = [];

    for (const pattern of patterns) {
      if (pattern.count < threshold) continue;

      // Don't re-propose rules that already exist
      if (this.rules.some((r) => r.id === `rule_${pattern.fingerprint}`)) continue;

      const rule: LearnedRule = {
        id: `rule_${pattern.fingerprint}`,
        description: `Auto-proposed: ${pattern.summary} (observed ${pattern.count} times)`,
        tool: pattern.tool,
        condition: (action) => action.tool === pattern.tool,
        verdict: pattern.typicalCorrection ? "CORRECTED" : "FLAGGED",
        correction: pattern.typicalCorrection,
        observedCount: pattern.count,
        approved: false,
        proposedAt: new Date().toISOString(),
      };

      proposals.push(rule);
    }

    return proposals;
  }

  /**
   * Approve a proposed rule. Only approved rules are active.
   * The approval is a human decision — the system proposes, the human disposes.
   */
  approveRule(ruleId: string): void {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (rule) {
      rule.approved = true;
      rule.approvedAt = new Date().toISOString();
    }
  }

  /**
   * Add a proposed rule to the engine (pending approval).
   */
  addProposedRule(rule: LearnedRule): void {
    this.rules.push(rule);
  }

  /**
   * Get all approved rules as a CriticFunction.
   * This creates a rule-based critic from learned patterns — Level 1 Learning.
   * Combine with createTieredCritic to use learned rules as the fast tier.
   */
  toRuleCritic(): CriticFunction {
    const approvedRules = this.rules.filter((r) => r.approved);

    return async ({ action, stateBefore, stateAfter }) => {
      for (const rule of approvedRules) {
        if (rule.condition(action, stateAfter)) {
          return {
            verdict: rule.verdict,
            reason: `[learned] ${rule.description}`,
            correction: rule.correction
              ? { tool: rule.correction.tool, input: rule.correction.input }
              : undefined,
          };
        }
      }
      return { verdict: "PASS", reason: "No learned rules triggered" };
    };
  }

  /**
   * Export correction history as fine-tuning data for the Critic model.
   * Level 2 Learning: critic fine-tuning.
   *
   * Returns an array of training examples in the format:
   * { input: (what the critic saw), output: (what the human approved) }
   */
  exportFineTuningData(
    entries: readonly LedgerEntry[]
  ): Array<{
    input: {
      action: ActionRecord;
      stateBefore: unknown;
      stateAfter: unknown;
    };
    output: {
      verdict: string;
      reason: string;
      correction?: { tool: string; input: Record<string, unknown> };
    };
    humanApproval: string | undefined;
  }> {
    return entries
      .filter(
        (e) =>
          (e.critic.verdict === "CORRECTED" || e.critic.verdict === "FLAGGED") &&
          e.approval !== undefined
      )
      .map((e) => ({
        input: {
          action: e.action,
          stateBefore: e.snapshots.before,
          stateAfter: e.snapshots.after,
        },
        output: {
          verdict: e.critic.verdict,
          reason: e.critic.reason,
          correction: e.critic.correction
            ? { tool: e.critic.correction.tool, input: e.critic.correction.input }
            : undefined,
        },
        humanApproval: e.approval,
      }));
  }

  /**
   * Export agent correction history for agent self-improvement.
   * Level 3 Learning: agent improvement.
   *
   * Returns a structured history the agent can use to avoid repeating mistakes:
   * "Last time I tried to close a regulatory hold account, it was FLAGGED."
   */
  exportAgentMemory(
    entries: readonly LedgerEntry[],
    agentId?: string
  ): Array<{
    tool: string;
    whatHappened: string;
    verdict: string;
    lesson: string;
  }> {
    return entries
      .filter(
        (e) =>
          (e.critic.verdict === "CORRECTED" || e.critic.verdict === "FLAGGED") &&
          (!agentId || e.agentId === agentId)
      )
      .map((e) => ({
        tool: e.action.tool,
        whatHappened: `Called ${e.action.tool} with ${JSON.stringify(e.action.input)}`,
        verdict: e.critic.verdict,
        lesson:
          e.critic.verdict === "CORRECTED"
            ? `This action was auto-corrected: ${e.critic.reason}. Avoid this pattern.`
            : `This action was FLAGGED and required human review: ${e.critic.reason}. Do not attempt this without explicit approval.`,
      }));
  }

  /**
   * Get all rules (proposed and approved).
   */
  getRules(): readonly LearnedRule[] {
    return this.rules;
  }

  /**
   * Get all detected patterns.
   */
  getPatterns(): CorrectionPattern[] {
    return Array.from(this.patterns.values());
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /**
   * Compute a SHA-256 fingerprint for a correction pattern.
   * Two corrections have the same fingerprint if they're the same type
   * of mistake on the same tool with the same correction target.
   */
  private computeFingerprint(entry: LedgerEntry): string {
    const parts = [
      entry.critic.verdict,
      entry.action.tool,
      entry.critic.correction?.tool ?? "none",
    ];
    return sha256(parts.join(":"));
  }
}
