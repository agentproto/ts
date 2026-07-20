/**
 * Pure rendering/sorting logic for the Harnesses tree view — no vscode import
 * so it's unit-testable under plain vitest.
 */

import type { AdapterInfo } from "../client/types.js"

export interface HarnessNode {
  adapter: AdapterInfo
}

const STATUS_RANK: Record<string, number> = {
  ready: 0,
  available: 1,
  supported: 2,
}

function rankFor(status?: string): number {
  return status === undefined ? Number.POSITIVE_INFINITY : (STATUS_RANK[status] ?? Number.POSITIVE_INFINITY)
}

/**
 * Sort adapters by readiness: ready first, then available, then supported.
 * Adapters with an unknown or missing status are placed last. The sort is
 * stable so adapters with the same status keep their input order.
 */
export function sortAdapters(adapters: AdapterInfo[]): AdapterInfo[] {
  return adapters.slice().sort((a, b) => rankFor(a.status) - rankFor(b.status))
}

export function harnessIcon(adapter: AdapterInfo): { id: string; color?: string } {
  if (adapter.status === "ready") return { id: "check" }
  if (adapter.status === "available") return { id: "circle-filled" }
  return { id: "info" }
}

export function harnessDescription(adapter: AdapterInfo): string {
  const hint = adapter.hint?.trim()
  if (hint) return hint
  const protocolVersion =
    adapter.protocol && adapter.version
      ? `${adapter.protocol}/${adapter.version}`
      : (adapter.protocol ?? adapter.version)
  if (protocolVersion) return protocolVersion
  return adapter.status ?? ""
}

export function harnessTooltip(adapter: AdapterInfo): string {
  const lines: string[] = []
  const title = adapter.name?.trim() || adapter.slug
  lines.push(`**${title}**`)
  lines.push("")
  lines.push(`- **Protocol:** ${adapter.protocol ?? "—"}`)
  lines.push(`- **Version:** ${adapter.version ?? "—"}`)
  const modelCount = adapter.models?.length ?? 0
  lines.push(`- **Models:** ${modelCount}`)
  const modeIds = adapter.modes?.map(m => m.id) ?? []
  lines.push(`- **Modes:** ${modeIds.join(", ") || "—"}`)
  return lines.join("\n")
}
