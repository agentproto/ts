/**
 * @agentproto/decision: the AIP-65 DECISION.md core.
 *
 * Policy parsing, bounded evidence collection, and the reusable typed
 * decision primitive. Host wiring (MCP tools, the Jev classifier, the
 * staged workflow and its escalation) stays in `@agentproto/runtime`.
 *
 * @see https://agentproto.sh/docs/aip-65
 */

export const SPEC_NAME = "decision/v1" as const

export {
  DECISION_CACHE_TTL_MS,
  buildEscalationPacket,
  clearDecisionCache,
  decide,
  decisionCacheSize,
  deniedEvidenceClass,
  evaluateWhen,
  projectTier1Evidence,
} from "./decision.js"
export type {
  ClassifierOutcome,
  DecideDeps,
  DecideOptions,
  DecisionBackendIdentity,
  DecisionEscalationHistoryEntry,
  DecisionOutcome,
  DecisionSource,
  DecisionStatus,
  EscalationOutcome,
  JevChoiceQuestion,
} from "./decision.js"
export {
  DECISION_POLICY_SCHEMA_VERSION,
  decisionPolicyFrontmatterSchema,
  decisionPolicyHash,
  hashStable,
  parseDecisionPolicy,
  stableStringify,
} from "./decision-policy.js"
export type {
  DecisionPolicy,
  DecisionPolicyFrontmatter,
  DecisionPolicyParse,
  DecisionWhen,
} from "./decision-policy.js"
export {
  DEFAULT_EVIDENCE_MAX_FILES,
  DEFAULT_EVIDENCE_TIMEOUT_MS,
  collectEvidence,
  defaultGit,
  sanitizeEvidence,
  scrubSecrets,
} from "./decision-evidence.js"
export type {
  CollectedEvidence,
  CollectEvidenceOptions,
  FrozenRange,
  GitRunner,
} from "./decision-evidence.js"
