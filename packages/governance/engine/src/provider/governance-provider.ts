/**
 * AIP-30 PROVIDER for the four `governance.*` TOOL contracts.
 *
 * `kind: "builtin"` — runs in-process against `governanceConfig`
 * injected via per-call context. No subprocess, no SDK package load,
 * no network hop. Bodies are typed via `implementTool` — the compiler
 * enforces shape match between each body and its contract's
 * input/output/context generics, the same way Solidity's
 * `MyToken is IERC20` enforces interface conformance.
 *
 * Each implementation here can be re-adapted to AI SDK or Mastra
 * surfaces via `toAiSdkTool(impl, { context })` / `toMastraTool(...)`,
 * so the same body powers `runTool({ candidates: [...] })` AND
 * `streamText({ tools: { ... } })` AND `agent.stream({ tools: ... })`
 * with no duplication.
 */

import { defineDriver } from "@agentproto/driver"

import { listPendingSignaturesBuiltin } from "./bodies/list-pending-signatures.body.js"
import { recordAuditEventBuiltin } from "./bodies/record-audit-event.body.js"
import { requestSignaturesBuiltin } from "./bodies/request-signatures.body.js"
import { signArtifactBuiltin } from "./bodies/sign-artifact.body.js"

export const governanceProvider = defineDriver({
  id: "governance-engine-builtin",
  name: "Governance Runtime (built-in)",
  description:
    "In-process implementation of the four AIP-7 governance contracts — " +
    "signature creation, audit logging, pending-signatures index. Operates " +
    "on a workspace root via `governanceConfig` injected from per-call context. " +
    "No subprocess, no network egress; the host owns the filesystem boundary.",
  version: "0.1.0",
  kind: "builtin",
  implements: [
    { tool: "governance.sign-artifact", version: "0.1.0" },
    { tool: "governance.record-audit-event", version: "0.1.0" },
    { tool: "governance.request-signatures", version: "0.1.0" },
    { tool: "governance.list-pending-signatures", version: "0.1.0" },
  ],
  // Typed bindings — each impl carries its contract handle, so
  // `defineDriver` derives the execute map keys from `impl.tool.id`
  // without the author restating them as strings. Drift between a
  // body and its contract is a compile error.
  implementations: [
    signArtifactBuiltin,
    recordAuditEventBuiltin,
    requestSignaturesBuiltin,
    listPendingSignaturesBuiltin,
  ],
})
