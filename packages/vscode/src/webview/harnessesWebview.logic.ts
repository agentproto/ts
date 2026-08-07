/**
 * Pure Harnesses webview model — no vscode import so it's unit-testable under
 * plain vitest. Reshapes the daemon's AdapterInfo list into the flat row model
 * the webview paints, mirroring the Sessions webview's logic/panel split.
 */

import type { AdapterInfo } from "../client/types.js"
import { canInstallHarness, harnessDescription } from "../views/harnessesTree.logic.js"
import { adapterLogoFor, type AdapterLogo } from "./adapterIcon.logic.js"

export type HarnessStatus = "ready" | "available" | "dim"

/**
 * The row's single labeled action button — always the same slot, never a
 * hover-swap:
 * - "start"      — installed harness, real `<button>` "▶ Start"
 * - "install"    — not yet installed, click kicks off adapter_install
 * - "installing" — optimistic state the panel sets right after the click,
 *   held until the next adapters refresh lands (panel-side; see
 *   harnessesWebviewPanel.ts). A row can only be "installing" while it's
 *   still installable — once the underlying adapter reports installed, the
 *   action falls back to "start" regardless of any stale optimistic flag.
 */
export type HarnessAction = "start" | "install" | "installing"

export interface HarnessWebviewRow {
  slug: string
  name: string
  description: string
  status: HarnessStatus
  installable: boolean
  action: HarnessAction
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

function actionFor(installable: boolean, installing: boolean): HarnessAction {
  if (!installable) return "start"
  return installing ? "installing" : "install"
}

function toRow(adapter: AdapterInfo, installingSlugs: ReadonlySet<string>): HarnessWebviewRow {
  const installable = canInstallHarness(adapter.status)
  return {
    slug: adapter.slug,
    name: adapter.name?.trim() || adapter.slug,
    description: harnessDescription(adapter),
    status: harnessStatusFor(adapter.status),
    installable,
    action: actionFor(installable, installingSlugs.has(adapter.slug)),
    logo: adapterLogoFor(adapter.slug),
  }
}

export function buildHarnessesWebviewModel(
  adapters: readonly AdapterInfo[],
  search: string,
  installingSlugs: ReadonlySet<string> = new Set(),
): HarnessesWebviewModel {
  const sorted = adapters
    .slice()
    .sort((a, b) => rawStatusRank(a.status) - rawStatusRank(b.status))
    .map(a => toRow(a, installingSlugs))
  const trimmed = search.trim()
  const visible = trimmed.length === 0 ? sorted : sorted.filter(r => rowMatchesSearch(r, trimmed))
  return { rows: visible, shownCount: visible.length, totalCount: adapters.length }
}
