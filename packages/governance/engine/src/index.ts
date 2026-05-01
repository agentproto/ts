/**
 * agentgovernance/v1 runtime — FS-only helpers.
 *
 * Three building blocks:
 *
 * 1. `recordAuditEvent` — append a hash-chained event to an audit log,
 *    handling chain state (loads last signature, falls back to genesis seed).
 *
 * 2. `signArtifact` — write a signature.json next to an artifact + record
 *    a `signature.created` audit event automatically.
 *
 * 3. `_index/pending-signatures.json` helpers — maintain the cache of
 *    "what's awaiting my signature" for fast operator-inbox queries.
 *
 * No Mastra, LangChain, Temporal imports. Workflow-runtime adapters live in
 * `@agentproto/governance-mastra` (etc.) and call into these helpers.
 */

export type {
  GovernanceConfig,
  AnchorPayload,
  AnchorSink,
} from "./workspace-config.js"
export { DEFAULT_ANCHOR_EVERY_LINES } from "./workspace-config.js"

export {
  recordAuditEvent,
  type RecordAuditEventInput,
  type RecordAuditEventResult,
} from "./audit-chain.js"

export {
  signArtifact,
  type SignArtifactInput,
  type SignArtifactResult,
} from "./sign-artifact.js"

export {
  loadPendingSignaturesIndex,
  addPendingSignatures,
  removePendingSignature,
  listPendingSignatures,
  type PendingSignatureEntry,
  type PendingSignaturesIndex,
} from "./pending-signatures-index.js"

export {
  ensureDir,
  readFileIfExists,
  atomicWrite,
  appendLine,
  sha256Hex,
  resolveFromRoot,
  toRelativePath,
  getFilesystem,
} from "./fs.js"

export {
  type IGovernanceFilesystem,
  type DirectoryEntry,
  NodeGovernanceFilesystem,
  defaultGovernanceFilesystem,
} from "./filesystem.js"
