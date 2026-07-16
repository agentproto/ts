/**
 * Pure spawn-wizard logic — cwd/workspace autodetection, quick-pick item
 * mapping, and spawn-options assembly. No `vscode` import so this is
 * directly unit-testable; the interactive wizard in spawn.ts calls into
 * these. vscode's own `WorkspaceFolder` is mirrored as `WorkspaceFolderLike`
 * so callers can pass plain data without this file depending on the vscode
 * module.
 */

import type { SpawnAgentOptions } from "../client/daemonClient.js"
import type { AdapterInfo, WorkspacesConfig } from "../client/types.js"
import { findWorkspaceByPath, workspaceLabel } from "../services/workspaces.logic.js"

/**
 * adapter_list's actual daemon response (see
 * packages/cli/src/registry/resolve.ts `AdapterListing`) carries `models`,
 * `status`, and `hint` fields beyond the frozen client `AdapterInfo`
 * contract (client/types.ts). Extended locally rather than editing that
 * frozen file — every added field is optional, so a plain `AdapterInfo`
 * still satisfies this shape.
 */
export interface SpawnAdapterInfo extends AdapterInfo {
  models?: string[]
  status?: "supported" | "available" | "ready"
  hint?: string
}

export interface AdapterQuickPickItem {
  label: string
  description?: string
  adapter: SpawnAdapterInfo
}

export const CUSTOM_MODEL_LABEL = "$(edit) custom…"

export interface ModelQuickPickItem {
  label: string
  custom?: boolean
}

export interface ModeQuickPickItem {
  label: string
  description?: string
  mode: string
}

/** Adapter picker: label = slug, description = hint/status; "ready" adapters sort first. */
export function mapAdapterQuickPickItems(adapters: SpawnAdapterInfo[]): AdapterQuickPickItem[] {
  const items = adapters.map(adapter => ({
    label: adapter.slug,
    description: adapter.hint ?? adapter.status ?? adapter.name,
    adapter,
  }))
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aReady = a.item.adapter.status === "ready" ? 0 : 1
      const bReady = b.item.adapter.status === "ready" ? 0 : 1
      if (aReady !== bReady) return aReady - bReady
      return a.index - b.index
    })
    .map(({ item }) => item)
}

/** Model picker: every declared model plus a trailing "custom…" entry. */
export function mapModelQuickPickItems(models: string[]): ModelQuickPickItem[] {
  return [...models.map(m => ({ label: m })), { label: CUSTOM_MODEL_LABEL, custom: true }]
}

/** Mode picker: only meaningful when the adapter declares modes at all. */
export function mapModeQuickPickItems(modes: SpawnAdapterInfo["modes"]): ModeQuickPickItem[] {
  return (modes ?? []).map(m => ({
    label: m.id,
    description: m.status_note ?? m.status,
    mode: m.id,
  }))
}

export const CONFIGURE_LABEL = "$(gear) Configure…"

export interface SpawnQuickPickItem {
  label: string
  description?: string
  /** Absent only on the trailing Configure… row. */
  adapter?: SpawnAdapterInfo
  model?: string
  /** Row asks for a typed-in model id instead of spawning immediately. */
  custom?: boolean
  /** The row opens the full mode/cwd/label/prompt chain unchanged. */
  configure?: boolean
}

/**
 * The collapsed spawn picker: every adapter's declared models flattened to
 * "slug · model" rows (plus a trailing "slug · custom…" row per adapter that
 * declares models), so picking one row is enough to spawn — mode/cwd/label/
 * prompt all default. An adapter with no declared models gets a single
 * bare-slug row (model omitted, adapter default applies) rather than a
 * custom row, since there is nothing to override. A trailing Configure… row
 * opens the untouched full chain for anyone who needs to change a default.
 * Adapter order matches mapAdapterQuickPickItems (ready adapters first).
 */
export function mapSpawnQuickPickItems(adapters: SpawnAdapterInfo[]): SpawnQuickPickItem[] {
  const items: SpawnQuickPickItem[] = []
  for (const { adapter } of mapAdapterQuickPickItems(adapters)) {
    const description = adapter.hint ?? adapter.status ?? adapter.name
    const models = adapter.models ?? []
    if (models.length === 0) {
      items.push({ label: adapter.slug, description, adapter })
      continue
    }
    for (const model of models) {
      items.push({ label: `${adapter.slug} · ${model}`, description, adapter, model })
    }
    items.push({ label: `${adapter.slug} · ${CUSTOM_MODEL_LABEL}`, description, adapter, custom: true })
  }
  items.push({ label: CONFIGURE_LABEL, configure: true })
  return items
}

/** Mirrors vscode's `WorkspaceFolder` — only the fields this module needs. */
export interface WorkspaceFolderLike {
  uri: { fsPath: string }
  name: string
}

export interface CwdResolutionInput {
  folders: readonly WorkspaceFolderLike[]
  /** fsPath of the active editor's document, when there is one. */
  activeFilePath?: string
}

export type CwdResolution =
  | { kind: "resolved"; cwd: string }
  | { kind: "ambiguous"; candidates: WorkspaceFolderLike[] }
  | { kind: "none" }

/**
 * Same longest-prefix, segment-boundary rule as
 * services/workspaces.logic.ts's isUnder — duplicated locally because it
 * operates over WorkspaceFolderLike (uri.fsPath) rather than WorkspaceEntry
 * (path), and a folder carries no slug to route through the shared helper.
 */
function normalizePath(p: string): string {
  const trimmed = p.replace(/\/+$/, "")
  return trimmed === "" ? "/" : trimmed
}

function isUnderFolder(filePath: string, folderPath: string): boolean {
  const f = normalizePath(filePath)
  const root = normalizePath(folderPath)
  if (f === root) return true
  return f.startsWith(root === "/" ? "/" : `${root}/`)
}

function longestPrefixFolder(
  folders: readonly WorkspaceFolderLike[],
  filePath: string,
): WorkspaceFolderLike | undefined {
  const matches = folders
    .filter(f => isUnderFolder(filePath, f.uri.fsPath))
    .sort((a, b) => normalizePath(b.uri.fsPath).length - normalizePath(a.uri.fsPath).length)
  return matches[0]
}

/**
 * Default-cwd ladder, most-specific first:
 *   1. the active editor's file → the folder containing it (longest-prefix
 *      match) → resolved.
 *   2. exactly one workspace folder → resolved.
 *   3. multiple folders and no active editor inside any of them → ambiguous
 *      (caller shows a folder quick-pick).
 *   4. no folders at all → none (caller falls back to a free-text input box).
 * A file outside every folder (e.g. a /tmp scratch buffer) falls through to
 * step 2/3 rather than resolving to the file's own directory.
 */
export function resolveDefaultCwd(input: CwdResolutionInput): CwdResolution {
  const { folders, activeFilePath } = input
  if (activeFilePath) {
    const containing = longestPrefixFolder(folders, activeFilePath)
    if (containing) return { kind: "resolved", cwd: containing.uri.fsPath }
  }
  if (folders.length === 1) {
    const sole = folders[0]
    if (sole) return { kind: "resolved", cwd: sole.uri.fsPath }
  }
  if (folders.length > 1) return { kind: "ambiguous", candidates: [...folders] }
  return { kind: "none" }
}

export interface FolderQuickPickItem {
  label: string
  description?: string
  folder: WorkspaceFolderLike
}

/** Folder disambiguation picker, shown only when resolveDefaultCwd reports "ambiguous". */
export function mapFolderQuickPickItems(folders: readonly WorkspaceFolderLike[]): FolderQuickPickItem[] {
  return folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f }))
}

/**
 * cwd → registered workspace slug, via the daemon's own longest-prefix rule
 * (services/workspaces.logic.ts). Undefined cwd or no registered match →
 * undefined, so the daemon falls back to its own inference rather than
 * receiving a wrong slug.
 */
export function resolveWorkspaceSlug(config: WorkspacesConfig, cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  return findWorkspaceByPath(config, cwd)?.slug
}

export interface SpawnWizardAnswers {
  adapter: string
  model?: string
  mode?: string
  cwd?: string
  workspaceSlug?: string
  label?: string
  prompt?: string
  /** Park each tool-permission request for a human decision — see PermissionQuickPickItem. */
  permissionHold?: boolean
}

/**
 * Permission picker. The whole approve/deny chain already exists — the
 * permissions inbox, the badge, the toast with Approve/Deny/Show, the
 * `POST /permissions/:id` round-trip — and none of it could ever fire,
 * because a session only PARKS a `session/request_permission` when it was
 * spawned with `permissionHold` (see packages/acp's client: hold intercepts
 * before the auto-answer handler). The extension never sent the flag, so the
 * adapter auto-answered every request and `GET /permissions` stayed `[]`
 * forever. This picker is the missing switch, not a new feature.
 */
export interface PermissionQuickPickItem {
  label: string
  description?: string
  hold: boolean
}

export function mapPermissionQuickPickItems(current: boolean): PermissionQuickPickItem[] {
  const items: PermissionQuickPickItem[] = [
    {
      label: "Unattended",
      description: "the agent decides for itself — nothing to approve",
      hold: false,
    },
    {
      label: "Ask me before each tool",
      description: "parks every request in the Permissions view and notifies you",
      hold: true,
    },
  ]
  // Lead with whatever the setting already says, so Enter re-picks the
  // current default instead of silently flipping it.
  return current ? [items[1]!, items[0]!] : items
}

/**
 * placeHolder for the collapsed spawn picker. The resolved default must be
 * visible up front — autodetection that silently applies a cwd/workspace is
 * the exact complaint this wizard exists to fix, and a spawn that will stop
 * and ask permission for every tool is exactly as surprising after the fact.
 */
export function buildSpawnPlaceHolder(
  config: WorkspacesConfig,
  cwd: string | undefined,
  permissionHold = false,
): string {
  const hold = permissionHold ? " · asking before each tool" : ""
  if (!cwd) {
    return `No workspace folder open — select adapter · model${hold} (Configure… to set a working directory)`
  }
  const slug = resolveWorkspaceSlug(config, cwd)
  const where = slug ? `${workspaceLabel(config, slug)} (${cwd})` : cwd
  return `Spawning in ${where} — select adapter · model${hold}`
}

/** Assemble the POST /sessions/agent body, omitting unset optional fields. */
export function assembleSpawnOptions(answers: SpawnWizardAnswers): SpawnAgentOptions {
  const opts: SpawnAgentOptions = { adapter: answers.adapter }
  if (answers.model) opts.model = answers.model
  if (answers.mode) opts.mode = answers.mode
  if (answers.cwd) opts.cwd = answers.cwd
  if (answers.workspaceSlug) opts.workspaceSlug = answers.workspaceSlug
  if (answers.label) opts.label = answers.label
  if (answers.prompt) opts.prompt = answers.prompt
  if (answers.permissionHold) opts.permissionHold = true
  return opts
}
