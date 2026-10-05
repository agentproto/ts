/**
 * @agentproto/review — the review primitive.
 *
 * A review is a workflow with a verdict contract:
 *   - REVIEW.md declares checks (command / agent lanes) and named bindings
 *     (`local`, `ci`, …) that pick which lanes attest and what prepares;
 *   - `compileReview` turns a binding into an ordinary AIP-15
 *     `WorkflowHandle` the existing workflow runtime executes (prepare →
 *     freeze range → parallel lanes → fan-in verdict);
 *   - the verdict (`pass | block | incomplete`) is bound to the manifest sha
 *     + git range in an {@link Attestation} a CI verifier can check.
 *
 * Pure: strings in, handles and values out. The daemon host
 * (`@agentproto/runtime`'s `review_*` tools) owns git, the lane executor,
 * and the ledger.
 */

export {
  parseReviewManifest,
  resolveBinding,
  getCheck,
  finalizeBindings,
  reviewFrontmatterSchema,
  checkReviewFrontmatter,
  buildReviewManifest,
  ReviewManifestError,
  DEFAULT_BINDING,
  DEFAULT_BASE_REF,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
  type ReviewManifest,
  type ReviewFrontmatter,
  type ReviewDefinition,
  type ReviewBinding,
  type ReviewCheck,
  type CommandCheck,
  type AgentCheck,
  type ReviewUse,
  type UsesOverride,
} from "./manifest.js"
export { defineReview, type ReviewHandle } from "./define-review.js"
export { parseGitPackRef, GitPackRefError } from "./git-pack-ref.js"
export { reviewPackFrontmatterSchema, type ReviewPackFrontmatter } from "./pack-schema.js"
export { attestationFrontmatterSchema, type AttestationFrontmatter } from "./attestation-schema.js"
export {
  parsePackManifest,
  resolvePacks,
  computePackDigestSha256,
  PACK_DIGEST_ALG,
  PackManifestError,
  type PackManifest,
  type PackCheck,
  type PackCommandCheck,
  type PackAgentCheck,
  type PackSource,
  type PackLoader,
  type ResolvePacksResult,
} from "./packs.js"
export {
  compileReview,
  toLaneResult,
  ReviewCompileError,
  RANGE_PLACEHOLDERS,
  type CompileReviewOptions,
  type CompiledReview,
  type LaneInvocation,
  type LaneOutcome,
  type ReviewLaneExecutor,
  type ReviewOutcome,
} from "./compile.js"
export {
  substitutePlaceholders,
  listPlaceholders,
  ReviewPlaceholderError,
} from "./placeholders.js"
export { foldVerdict, agentLaneStatus, meetsSeverity } from "./verdict.js"
export {
  buildAgentLanePrompt,
  parseAgentLaneReport,
  agentLaneReportSchema,
  AgentLaneReportError,
  type AgentLaneReport,
  type AgentLanePromptInput,
} from "./agent-lane.js"
export {
  buildAttestation,
  verifyAttestation,
  manifestSha,
  rangeSha,
  sha256Hex,
  ledgerKeyOf,
  canonicalAttestationBytes,
  attestationSha256,
  type BuildAttestationInput,
  type LedgerKey,
  type VerifyAttestationExpect,
  type VerifyAttestationResult,
} from "./attestation.js"
export { canonicalJson } from "./canonical-json.js"
export {
  ATTESTATION_SCHEMA,
  type Attestation,
  type Attestor,
  type CheckKind,
  type Finding,
  type LaneFallback,
  type LaneResult,
  type LaneStatus,
  type PackDigest,
  type Quorum,
  type ReviewPrRef,
  type ReviewRequester,
  type ReviewTarget,
  type RubricDigest,
  type Severity,
  type Verdict,
} from "./types.js"
