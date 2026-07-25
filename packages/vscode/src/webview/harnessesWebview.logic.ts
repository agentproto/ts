/**
 * Pure Harnesses webview model — no vscode import so it's unit-testable under
 * plain vitest. Reshapes the daemon's AdapterInfo list into the flat row model
 * the webview paints, mirroring the Sessions webview's logic/panel split.
 */

import type { AdapterInfo } from "../client/types.js"
import { canInstallHarness, harnessDescription } from "../views/harnessesTree.logic.js"
import { adapterLogoFor, type AdapterLogo } from "./adapterIcon.logic.js"

export type HarnessStatus = "ready" | "available" | "dim"

export interface HarnessWebviewRow {
  slug: string
  name: string
  description: string
  status: HarnessStatus
  installable: boolean
  logo: AdapterLogo
}

export interface HarnessesWebviewModel {
  rows: HarnessWebviewRow[]
  shownCount: number
  totalCount: number
}

export function harnessStatusFor(status: string | undefined): HarnessStatus {
  if (status === "ready") return "ready"
  if (status === "available" || status === "supported") return "available"
  return "dim"
}

const STATUS_RANK: Record<string, number> = {
  ready: 0,
  available: 1,
  supported: 2,
}

function rawStatusRank(status: string | undefined): number {
  return status === undefined ? Number.POSITIVE_INFINITY : (STATUS_RANK[status] ?? Number.POSITIVE_INFINITY)
}

function rowMatchesSearch(row: HarnessWebviewRow, search: string): boolean {
  if (search.length === 0) return true
  const term = search.toLowerCase()
  return (
    row.slug.toLowerCase().includes(term) ||
    row.name.toLowerCase().includes(term) ||
    row.description.toLowerCase().includes(term)
  )
}

function toRow(adapter: AdapterInfo): HarnessWebviewRow {
  return {
    slug: adapter.slug,
    name: adapter.name?.trim() || adapter.slug,
    description: harnessDescription(adapter),
    status: harnessStatusFor(adapter.status),
    installable: canInstallHarness(adapter.status),
    logo: adapterLogoFor(adapter.slug),
  }
}

export function buildHarnessesWebviewModel(
  adapters: readonly AdapterInfo[],
  search: string,
): HarnessesWebviewModel {
  const sorted = adapters
    .slice()
    .sort((a, b) => rawStatusRank(a.status) - rawStatusRank(b.status))
    .map(toRow)
  const trimmed = search.trim()
  const visible = trimmed.length === 0 ? sorted : sorted.filter(r => rowMatchesSearch(r, trimmed))
  return { rows: visible, shownCount: visible.length, totalCount: adapters.length }
}
