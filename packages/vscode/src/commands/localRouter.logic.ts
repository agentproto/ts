/**
 * Pure outcome→message mapping for the Local Router start/stop commands — no
 * vscode import so it's unit-testable, mirroring the sibling `*.logic.ts`
 * command modules. The thin vscode shell (localRouter.ts) calls these and hands
 * the strings to `showInformationMessage` / `showErrorMessage`.
 */

import type {
  LlmEndpointDescriptorResult,
  LlmEndpointReloadPacksResult,
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

/** Error-toast text for a failed start/stop/reload — `action` is the verb
 *  folded into "Could not <action> the Local Router['s packs]: <reason>". */
export function localRouterErrorMessage(action: "start" | "stop" | "reload", err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err)
  if (action === "reload") return `Could not reload the Local Router's packs: ${reason}`
  return `Could not ${action} the Local Router: ${reason}`
}
