/**
 * Pure outcome→message mapping for the Local Router start/stop commands — no
 * vscode import so it's unit-testable, mirroring the sibling `*.logic.ts`
 * command modules. The thin vscode shell (localRouter.ts) calls these and hands
 * the strings to `showInformationMessage` / `showErrorMessage`.
 */

import type {
  LlmEndpointDescriptorResult,
  LlmEndpointReloadPacksResult,
  LlmEndpointUpstreamTestResult,
} from "../client/types.js"

/** Info-toast text after a successful `llm_endpoint_start` — names the port and
 *  distinguishes a fresh spawn from an idempotent already-running no-op. */
export function startLlmEndpointMessage(desc: LlmEndpointDescriptorResult): string {
  return desc.wasAlreadyRunning
    ? `Local Router already running on :${desc.port}.`
    : `Started Local Router on :${desc.port}.`
}

/** Info-toast text after a successful `llm_endpoint_stop`. */
export function stopLlmEndpointMessage(): string {
  return "Stopped the Local Router."
}

/** Info-toast text after a successful `POST /v1/packs/reload` — names the
 *  reloaded pack count and how many of them came from packs.local.json. */
export function reloadLlmEndpointPacksMessage(result: LlmEndpointReloadPacksResult): string {
  const local = result.local_pack_ids.length
  return `Reloaded packs — ${result.count} available (${local} local).`
}

/** Info-toast text after a per-upstream live test — names the upstream and the
 *  verdict (ok / failed with the HTTP status + detail, or a "no cheap probe"
 *  note). Never carries a secret. */
export function testLlmEndpointUpstreamMessage(result: LlmEndpointUpstreamTestResult): string {
  if (result.ok === null) {
    return `Upstream ${result.provider}: no cheap probe available (${result.reason}).`
  }
  return result.ok
    ? `Upstream ${result.provider}: OK (HTTP ${result.status} — ${result.detail}).`
    : `Upstream ${result.provider}: failed (HTTP ${result.status} — ${result.detail}).`
}

/** Error-toast text for a failed start/stop/reload/test — `action` is the verb
 *  folded into "Could not <action> the Local Router['s packs / upstream]: <reason>". */
export function localRouterErrorMessage(
  action: "start" | "stop" | "reload" | "test",
  err: unknown,
): string {
  const reason = err instanceof Error ? err.message : String(err)
  if (action === "reload") return `Could not reload the Local Router's packs: ${reason}`
  if (action === "test") return `Could not test the Local Router upstream: ${reason}`
  return `Could not ${action} the Local Router: ${reason}`
}
