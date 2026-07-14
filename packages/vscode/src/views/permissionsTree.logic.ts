/**
 * Pure rendering/diffing logic for the permissions tree — NO vscode import
 * (see sessionStore.logic.ts for the pattern this mirrors) so it's
 * unit-testable under plain vitest.
 */

import type { PendingPermission } from "../client/types.js"

/**
 * The daemon's GET /permissions enriches each raw PendingPermission with the
 * owning session's label/title/adapter and a precomputed age (recon
 * §HTTP routes, `enrichPermission` in http-server.ts). None of that is part
 * of the frozen client/types.ts contract, so it's modeled here as optional
 * additions on top of it.
 */
export interface EnrichedPermission extends PendingPermission {
  sessionLabel?: string
  sessionTitle?: string
  adapter?: string
  ageMs?: number
}

/** Tree item label: the tool/title the agent is asking permission for. */
export function permissionLabel(perm: PendingPermission): string {
  const tool = perm.toolName?.trim()
  if (tool) return tool
  const firstLine = perm.text.split("\n")[0]?.trim()
  return firstLine || "Permission request"
}

/** Age of the request in ms, preferring the daemon's precomputed `ageMs`. */
export function permissionAgeMs(perm: EnrichedPermission, nowMs: number): number {
  if (typeof perm.ageMs === "number") return Math.max(0, perm.ageMs)
  const requested = Date.parse(perm.requestedAt)
  if (Number.isNaN(requested)) return 0
  return Math.max(0, nowMs - requested)
}

/** Human-readable "Ns/Nm/Nh/Nd ago" — coarsest unit that fits. */
export function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

/** Tree item description: "<session label> · <age>". */
export function permissionDescription(perm: EnrichedPermission, nowMs: number): string {
  const who = perm.sessionLabel?.trim() || perm.sessionTitle?.trim() || shortId(perm.sessionId)
  return `${who} · ${formatAge(permissionAgeMs(perm, nowMs))}`
}

/** Full request detail as markdown text (caller wraps in vscode.MarkdownString). */
export function buildPermissionTooltip(perm: EnrichedPermission, nowMs: number): string {
  const lines: string[] = []
  lines.push(`**${permissionLabel(perm)}**`)
  const who = perm.sessionLabel?.trim() || perm.sessionTitle?.trim() || perm.sessionId
  lines.push(`Session: ${who}  ·  ${formatAge(permissionAgeMs(perm, nowMs))}`)
  lines.push("")
  lines.push(perm.text)
  if (perm.options.length > 0) {
    lines.push("")
    lines.push("Options:")
    for (const o of perm.options) {
      const label = o.name?.trim() || o.optionId
      lines.push(`- ${label}${o.kind ? ` (\`${o.kind}\`)` : ""}`)
    }
  }
  return lines.join("\n")
}

/**
 * Ids present in `current` that weren't in `previousIds` — the toast-worthy
 * new arrivals on this refresh. Order follows `current`.
 */
export function diffNewPermissionIds(
  previousIds: ReadonlySet<string>,
  current: readonly { id: string }[],
): string[] {
  return current.filter(p => !previousIds.has(p.id)).map(p => p.id)
}
