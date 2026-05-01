/**
 * Public surface of the governance built-in provider.
 *
 * Two layers:
 *
 * - `governanceProvider` — the AIP-30 PROVIDER handle, ready for
 *   `runTool({ candidates: [governanceProvider] })` resolver dispatch.
 *
 * - `*Builtin` — the individual `ToolImplementation`s that compose the
 *   provider. Adapters (`@agentproto/adapter-mastra`,
 *   `@agentproto/adapter-ai-sdk`, …) consume these directly when
 *   per-tool routing isn't needed.
 */

export { governanceProvider } from "./governance-provider.js"

export { signArtifactBuiltin } from "./bodies/sign-artifact.body.js"
export { recordAuditEventBuiltin } from "./bodies/record-audit-event.body.js"
export { requestSignaturesBuiltin } from "./bodies/request-signatures.body.js"
export { listPendingSignaturesBuiltin } from "./bodies/list-pending-signatures.body.js"
