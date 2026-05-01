/**
 * AIP-14 governance tools — static `defineTool` handles wrapping the
 * `@agentproto/governance-engine` helpers.
 *
 * Each tool is a single global handle that reads `governanceConfig`
 * from the per-call context (validated by its `contextSchema`). One
 * handle serves any number of workspaces / tenants — adapters wire the
 * config in at invocation time via `resolveContext`.
 *
 * Adapters in `@agentproto/adapter-mastra` (and future `@agentproto/adapter-langchain`,
 * `@agentproto/adapter-a2a`) consume these handles and project them into their
 * native tool surface.
 */

import { signArtifactTool } from "./sign-artifact.tool.js"
import { recordAuditEventTool } from "./record-audit-event.tool.js"
import { requestSignaturesTool } from "./request-signatures.tool.js"
import { listPendingSignaturesTool } from "./list-pending-signatures.tool.js"

export {
  signArtifactTool,
  recordAuditEventTool,
  requestSignaturesTool,
  listPendingSignaturesTool,
}

export const governanceTools = {
  signArtifact: signArtifactTool,
  recordAuditEvent: recordAuditEventTool,
  requestSignatures: requestSignaturesTool,
  listPendingSignatures: listPendingSignaturesTool,
} as const

export type GovernanceToolBundle = typeof governanceTools
