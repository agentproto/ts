/**
 * Pure outcome→message mapping for the Local Router start/stop commands — no
 * vscode import so it's unit-testable, mirroring the sibling `*.logic.ts`
 * command modules. The thin vscode shell (localRouter.ts) calls these and hands
 * the strings to `showInformationMessage` / `showErrorMessage`.
 */

import type { LlmEndpointDescriptorResult } from "../client/types.js"

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

/** Error-toast text for a failed start/stop — `action` is the verb folded into
 *  "Could not <action> the Local Router: <reason>". */
export function localRouterErrorMessage(action: "start" | "stop", err: unknown): string {
  return `Could not ${action} the Local Router: ${err instanceof Error ? err.message : String(err)}`
}
