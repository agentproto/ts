/**
 * Pure spawn-wizard logic — cwd/workspace autodetection, quick-pick item
 * mapping, and spawn-options assembly. No `vscode` import so this is
 * directly unit-testable; the interactive wizard in spawn.ts calls into
 * these. vscode's own `WorkspaceFolder` is mirrored as `WorkspaceFolderLike`
 * so callers can pass plain data without this file depending on the vscode
 * module.
 */

import type { SpawnAgentOptions } from "../client/daemonClient.js"
import type {
  AdapterInfo,
  AdapterModelInfo,
  CatalogModelsResponse,
  CatalogProduct,
  CatalogRoute,
  CatalogVendor,
  WorkspacesConfig,
} from "../client/types.js"
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

/**
 * An adapter's declared models, normalised to `AdapterModelInfo[]` — the
 * daemon's structured projection when present, or each bare `models` id
 * lifted to `{id}` (provider unstated) for an older daemon / a test
 * fixture that only set the flat list. Every model-menu builder in this
 * module (the collapsed picker, the Configure… chain's provider step)
 * reads models through this so both stay in sync automatically.
 */
export function modelEntriesOf(adapter: SpawnAdapterInfo): AdapterModelInfo[] {
  if (adapter.modelDetails && adapter.modelDetails.length > 0) return adapter.modelDetails
  return (adapter.models ?? []).map((id) => ({ id }))
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
export const CUSTOM_MODEL_SECTION_LABEL = "Custom model…"

/**
 * Mirrors `vscode.QuickPickItemKind.Separator` (`-1`) without importing
 * `vscode` — this module is deliberately vscode-free so it stays directly
 * unit-testable. A plain `number` is structurally assignable to the real
 * enum (TypeScript's numeric-enum leniency), so `spawn.ts` can pass this
 * array straight to `showQuickPick` unchanged.
 */
const SEPARATOR_KIND = -1

export interface SpawnQuickPickItem {
  label: string
  description?: string
  /** Set only on a group-heading row (`SEPARATOR_KIND`) — vscode ignores
   *  every other field when this is set, and the row can't be picked. */
  kind?: number
  /** Absent on a heading row and on the trailing Configure… row. */
  adapter?: SpawnAdapterInfo
  model?: string
  /** The model's bound adapter mode (AIP-45 `models.allowed[].mode`), so
   *  picking a gateway model applies its routing mode automatically —
   *  without this a gateway model id spawns in the adapter's default mode
   *  (i.e. against the wrong provider). Absent for a native/unbound model. */
  mode?: string
  /** Row asks for a typed-in model id instead of spawning immediately. */
  custom?: boolean
  /** The row opens the full mode/cwd/label/prompt chain unchanged. */
  configure?: boolean
}

/**
 * The collapsed spawn picker: every adapter's declared models grouped under
 * a provider heading (`vscode.QuickPickItemKind.Separator`) — the provider
 * is the heading, not a label prefix, because "which brain" (the model) and
 * "who serves it" (the adapter, shown in the row's description) are
 * different questions. A model whose manifest entry binds a `mode` (a
 * gateway model) carries that mode on the row, so picking it applies the
 * mode automatically instead of silently spawning in the adapter's default
 * (== native == wrong provider for a gateway id). A model with no stated
 * provider is grouped under its adapter's own name instead — an unstated
 * provider is never guessed. An adapter with no declared models gets a
 * single bare-slug row of its own (model omitted, adapter default applies)
 * instead of a custom row, since there is nothing to override; every other
 * model-declaring adapter's "type any id" row is collected under one
 * trailing custom-model section. A trailing Configure… row opens the full
 * chain unchanged. Adapter order matches mapAdapterQuickPickItems (ready
 * adapters first); group order follows first appearance in that order.
 */
export function mapSpawnQuickPickItems(adapters: SpawnAdapterInfo[]): SpawnQuickPickItem[] {
  const groups = new Map<string, { heading: string; rows: SpawnQuickPickItem[] }>()
  const customRows: SpawnQuickPickItem[] = []

  function groupFor(key: string, heading: string): { heading: string; rows: SpawnQuickPickItem[] } {
    const existing = groups.get(key)
    if (existing) return existing
    const created = { heading, rows: [] as SpawnQuickPickItem[] }
    groups.set(key, created)
    return created
  }

  for (const { adapter } of mapAdapterQuickPickItems(adapters)) {
    const description = adapter.hint ?? adapter.status ?? adapter.name
    const entries = modelEntriesOf(adapter)
    if (entries.length === 0) {
      groupFor(`adapter:${adapter.slug}`, adapter.slug).rows.push({ label: adapter.slug, description, adapter })
      continue
    }
    for (const entry of entries) {
      const key = entry.provider ?? `adapter:${adapter.slug}`
      groupFor(key, entry.provider ?? adapter.slug).rows.push({
        label: entry.id,
        description: adapter.slug,
        adapter,
        model: entry.id,
        ...(entry.mode ? { mode: entry.mode } : {}),
      })
    }
    customRows.push({ label: `${adapter.slug} · ${CUSTOM_MODEL_LABEL}`, description, adapter, custom: true })
  }

  const items: SpawnQuickPickItem[] = []
  for (const group of groups.values()) {
    items.push({ label: group.heading, kind: SEPARATOR_KIND })
    items.push(...group.rows)
  }
  if (customRows.length > 0) {
    items.push({ label: CUSTOM_MODEL_SECTION_LABEL, kind: SEPARATOR_KIND })
    items.push(...customRows)
  }
  items.push({ label: CONFIGURE_LABEL, configure: true })
  return items
}

// ── Catalog-based spawn picker (SPEC §5) ────────────────────────────────────

/**
 * Build spawn picker items from the daemon's unified model catalog instead
 * of adapter manifest `models.allowed[]`. Groups by vendor, shows runnable
 * status, and carries route info for spawn-time routing.
 *
 * Every runnable model gets one row per route; non-runnable models are shown
 * with a "(no profile)" description so the user sees the gap rather than
 * a mysteriously missing model. The first adapter in the route's `adapters`
 * list is used as the default harness.
 */
export function mapCatalogSpawnQuickPickItems(catalog: CatalogModelsResponse): SpawnQuickPickItem[] {
  const items: SpawnQuickPickItem[] = []

  for (const vendor of catalog.vendors) {
    items.push({ label: vendor.vendor, kind: SEPARATOR_KIND })

    for (const product of vendor.products) {
      for (const route of product.routes) {
        const ref = route.ref
        const isRunnable = route.runnable
        const profileHint = isRunnable ? route.route : `${route.route} · no profile`
        const adapters = route.adapters
        const defaultAdapter = adapters[0] ?? vendor.vendor

        items.push({
          label: product.product,
          description: `${defaultAdapter} · ${profileHint}`,
          adapter: { slug: defaultAdapter, name: defaultAdapter } as SpawnAdapterInfo,
          model: ref,
          mode: route.adapterModes[0],
        })
      }
    }
  }

  items.push({ label: CONFIGURE_LABEL, configure: true })
  return items
}

export interface ProviderQuickPickItem {
  label: string
  description?: string
  /** Filter key for the model step — undefined means "this adapter's own
   *  unstated-provider models" (there's no real provider to narrow by, so
   *  the row is labelled with the adapter's name instead of a provider id,
   *  mirroring mapSpawnQuickPickItems' own-name grouping). */
  provider?: string
}

/**
 * Provider picker for the Configure… chain — the step the plan adds ahead
 * of model selection. Options are the distinct `provider` values across the
 * adapter's declared models (unstated entries collapse to one "adapter's
 * own name" option), in first-appearance order. Empty when the adapter
 * declares no models at all, so the caller can skip straight to the
 * existing (custom-only) model step.
 */
export function mapProviderQuickPickItems(adapter: SpawnAdapterInfo): ProviderQuickPickItem[] {
  const seen = new Map<string | undefined, ProviderQuickPickItem>()
  for (const entry of modelEntriesOf(adapter)) {
    const key = entry.provider
    if (!seen.has(key)) {
      seen.set(key, { label: key ?? adapter.slug, provider: key })
    }
  }
  return [...seen.values()]
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
  /** Saved user preset selected before the custom axis picker. The daemon
   * expands it; fields selected by the wizard remain higher precedence. */
  presetId?: string
  model?: string
  mode?: string
  cwd?: string
  workspaceSlug?: string
  label?: string
  prompt?: string
  /** Park each tool-permission request for a human decision — see PermissionQuickPickItem. */
  permissionHold?: boolean
  /** Give this session a scoped gateway so ITS spawns are attributed to it — see OrchestratorQuickPickItem. */
  orchestrator?: boolean
}

/**
 * Orchestrator picker — the switch that makes subagents visible.
 *
 * The sessions tree already nests children under the session that spawned
 * them, at any depth, and keeps a subtree with its root across the recency
 * divider. It has simply never had anything to nest: the daemon attributes
 * `parentSessionId` from `callerScope?.ownerSessionId`, and `callerScope`
 * exists only on the scoped sub-gateway minted for an `orchestrator: true`
 * spawn (session-spawn.ts: "no callerScope is a root: depth 0, no parent, no
 * caps"). Every spawn through the root `/mcp` is a root. `SpawnAgentOptions`
 * has carried the `orchestrator` field all along; the wizard just never sent
 * it, so an orchestrator was unspawnable from the editor.
 *
 * That the daemon needs a scoped gateway to attribute is not arbitrary: an
 * MCP client on the root `/mcp` is anonymous, and the daemon cannot record a
 * parent it cannot identify. The token IS the identity.
 *
 * Deliberately a per-spawn step and NOT a setting, unlike holdPermissions.
 * "Approve my tools" is a standing preference; "this agent supervises others"
 * is a fact about one job. A default-on setting would also silently subject
 * every spawn to the depth cap, the child quota and subtree-only
 * list/kill — see the description below, which says so up front.
 */
export interface OrchestratorQuickPickItem {
  label: string
  description?: string
  orchestrator: boolean
}

export function mapOrchestratorQuickPickItems(): OrchestratorQuickPickItem[] {
  return [
    {
      label: "Standalone",
      description: "anything it spawns is listed as its own top-level session",
      orchestrator: false,
    },
    {
      label: "Orchestrator",
      description: "its subagents nest under it — adds depth/child caps and subtree-only list & stop",
      orchestrator: true,
    },
  ]
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
  // Both flags are sent ONLY when true: false is the daemon's own default, so
  // saying it adds nothing and asserting it would be a claim we don't need to
  // make.
  if (answers.orchestrator) opts.orchestrator = true
  return opts
}
