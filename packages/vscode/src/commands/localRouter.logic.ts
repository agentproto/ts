/**
 * Pure outcome→message mapping for the Local Router start/stop commands — no
 * vscode import so it's unit-testable, mirroring the sibling `*.logic.ts`
 * command modules. The thin vscode shell (localRouter.ts) calls these and hands
 * the strings to `showInformationMessage` / `showErrorMessage`.
 */

import type {
  LlmEndpointDescriptorResult,
  LlmEndpointReloadPacksResult,
  LlmEndpointSetLinkResult,
  LlmEndpointUpstreamTestResult,
  UpstreamLinkInfo,
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

/** Error-toast text for a failed start/stop/reload/test/link — `action` is the
 *  verb folded into "Could not <action> the Local Router['s packs/upstream]: …". */
export function localRouterErrorMessage(
  action: "start" | "stop" | "reload" | "test" | "link",
  err: unknown,
): string {
  const reason = err instanceof Error ? err.message : String(err)
  if (action === "reload") return `Could not reload the Local Router's packs: ${reason}`
  if (action === "test") return `Could not test the Local Router upstream: ${reason}`
  if (action === "link") return `Could not link the Local Router upstream: ${reason}`
  return `Could not ${action} the Local Router: ${reason}`
}

/** One QuickPick option for linking an upstream to a profile — a profile choice
 *  or the "unlink" (`profileId: null`) escape. `picked` marks the current link. */
export interface LinkQuickPickItem {
  label: string
  description: string
  profileId: string | null
  picked: boolean
}

/** The sentinel label for the "revert to the per-provider env key" option. */
export const UNLINK_QUICK_PICK_LABEL = "$(circle-slash) Use env key (unlink)"

/**
 * Build the QuickPick options for linking `upstream`: one row per eligible
 * profile (labeled `<label or id>`, described by method + endpoint, and marked
 * `picked` when it is the current link), followed by the "Use env key (unlink)"
 * escape (marked `picked` when the upstream is currently unlinked). Pure so the
 * vscode shell just maps these to `QuickPickItem`s.
 */
export function buildLinkQuickPickItems(upstream: UpstreamLinkInfo): LinkQuickPickItem[] {
  const items: LinkQuickPickItem[] = upstream.eligible.map(p => ({
    label: p.label ? `${p.label} (${p.id})` : p.id,
    description: `${p.method} · ${p.endpoint}`,
    profileId: p.id,
    picked: upstream.linkedProfile === p.id,
  }))
  items.push({
    label: UNLINK_QUICK_PICK_LABEL,
    description: "authenticate this upstream from its per-provider env key",
    profileId: null,
    picked: upstream.linkedProfile === null,
  })
  return items
}

/** The QuickPick title/placeholder when there are no eligible profiles — a dead
 *  end that still lets the user unlink. */
export function noEligibleProfilesPlaceholder(provider: string): string {
  return `No auth-profiles are eligible for "${provider}" — create one at its billing endpoint first, or unlink.`
}

/** Info-toast text after a successful `llm_endpoint_set_upstream_link`. Names the
 *  new link (or unlink) and whether a restart is needed to apply it. */
export function setUpstreamLinkMessage(result: LlmEndpointSetLinkResult): string {
  const target =
    result.profileId === null
      ? `Unlinked ${result.provider} (env key)`
      : `Linked ${result.provider} → ${result.profileId}`
  const tail = result.restartRequired
    ? "restart the Local Router to apply."
    : "applies on next start."
  return `${target} — ${tail}`
}
