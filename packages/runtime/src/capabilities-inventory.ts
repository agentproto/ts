/**
 * `capabilities_inventory` — one read that answers "what MCP servers and
 * skills does this daemon actually know about, and which harnesses can
 * reach them?" Backs both the `capabilities_inventory` MCP tool
 * (session-tools.ts) and its HTTP twin (`GET /capabilities/inventory`,
 * http-server.ts) so the two surfaces can never drift.
 *
 * Read-only, never throws: a failure in one source (MCP discovery, the
 * proxy registry, an adapter package that fails to import) becomes an
 * `error` string on that block alone — the rest of the inventory still
 * returns. Redaction: nothing here ever carries command/args/env/headers/
 * url — only the identity/status fields a UI needs (same discipline as
 * `compactDiscoveredMcp` / `compactImportedMcpEntry`).
 *
 * The `skills` block's per-adapter `metadata.skills` / `options` read uses
 * the same dynamic-`import()` + duck-typed-export technique as
 * `role-registry.ts`'s adapter-carried role discovery — reused rather than
 * reinvented, and importantly NOT a `packages/cli` dependency: it walks the
 * exact adapter list `listAgentAdapters` already returned (so `byHarness`
 * is guaranteed the same installed set as `adapter_list`), importing each
 * adapter's own already-installed package by its `packageName`.
 */

import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { SessionsRegistry } from "./sessions.js"
import type { AgentAdapterLister, AdapterListEntry } from "./http-server.js"
import type { McpProxyRegistry } from "./mcp-proxy.js"
import { loadImportedMcps as loadImportedMcpsReal, secretRefKeys, type ImportedMcpsConfig } from "./mcp-imports.js"
import { discoverMcps as discoverMcpsReal, type DiscoveredMcp } from "./mcp-discovery.js"
import { shouldInjectDaemonSelfMount } from "./session-spawn.js"
import { loadConfig as loadConfigReal, type AgentprotoConfig } from "./config.js"
import { loadBundles as loadBundlesReal, type BundlesFile } from "./bundles.js"
import { resolveBundleDefaults } from "./spawn-defaults.js"

/** How a harness reaches one imported MCP by default:
 *  - `native`   — a default bundle mounts it as a native mcpServers entry;
 *  - `indirect` — only via the daemon's own `/mcp` (`mcp_imported_call`),
 *                 which the harness gets by default / config / bundle;
 *  - `none`     — no default path (still reachable on request). */
export type ImportedMcpReach = "native" | "indirect" | "none"

export interface CapabilitiesInventoryImportedMcp {
  id: string
  alias?: string
  name: string
  type: string
  source: string
  status: "connected" | "idle" | "error" | "unknown"
  error?: string
  /** Only present when `status === "connected"` — never connects just to count. */
  toolCount?: number
  usedBySessions: string[]
  /** `live` re-reads the source harness config; `snapshot` uses the stored copy. */
  resolve?: "live" | "snapshot"
  /** Set when the last resolution fell back (source missing / secret unresolved). */
  stale?: { reason: string }
  /** Header/env KEY names held behind secret refs (never values). */
  secretRefKeys?: { headers?: string[]; env?: string[] }
  /** Per installed adapter: how it reaches this import with NO per-spawn
   *  arguments (resolved default bundles + daemon self-mount default). */
  reach: Record<string, ImportedMcpReach>
}

export interface CapabilitiesInventoryDiscoveredMcp {
  id: string
  source: string
  scope: string
  name: string
  type: string
  imported: boolean
}

export interface CapabilitiesInventoryMcp {
  imported: CapabilitiesInventoryImportedMcp[]
  discovered: CapabilitiesInventoryDiscoveredMcp[]
  /** Which harnesses get the daemon's own `/mcp` (and so the imported pool)
   *  mounted by default — derived from `shouldInjectDaemonSelfMount` +
   *  each installed adapter's declared protocol, never a hardcoded list. */
  daemonMountByHarness: Record<string, "default" | "on-request" | "none">
  error?: string
}

export interface SkillPackInventoryEntry {
  name: string
  version?: string
  path: string
  skills: string[]
}

export interface SkillsByHarnessEntry {
  adapter: string
  target?: { format: string; dir: string; unit?: string }
  installed: string[]
  native: string[]
  spawnOption: boolean
}

export interface CapabilitiesInventorySkills {
  packs: SkillPackInventoryEntry[]
  byHarness: SkillsByHarnessEntry[]
  defaults: { global: string[]; byAdapter: Record<string, string[]> }
  error?: string
}

export interface CapabilitiesInventory {
  mcp: CapabilitiesInventoryMcp
  skills: CapabilitiesInventorySkills
}

export interface CapabilitiesInventoryDeps {
  registry?: SessionsRegistry
  listAgentAdapters?: AgentAdapterLister
  mcpProxy?: McpProxyRegistry
  /** Test seam — defaults to the real `loadImportedMcps` (reads
   *  `~/.agentproto/imported-mcps.json`). */
  loadImportedMcps?: () => Promise<ImportedMcpsConfig>
  /** Test seam — defaults to the real `discoverMcps` (scans the host's
   *  other agent tooling configs). */
  discoverMcps?: () => Promise<DiscoveredMcp[]>
  /** Test seam — defaults to the real `loadConfig` (reads
   *  `~/.agentproto/config.json`). */
  loadConfig?: () => Promise<AgentprotoConfig>
  /** Test seam — defaults to the real `loadBundles` (reads
   *  `~/.agentproto/bundles.json`). */
  loadBundles?: () => Promise<BundlesFile>
}

const EMPTY_MCP: CapabilitiesInventoryMcp = {
  imported: [],
  discovered: [],
  daemonMountByHarness: {},
}

const EMPTY_SKILLS: CapabilitiesInventorySkills = {
  packs: [],
  byHarness: [],
  defaults: { global: [], byAdapter: {} },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ── mcp block ──────────────────────────────────────────────────────────

/** Reach classification for one installed adapter — pure, derived from
 *  today's self-mount rule (`shouldInjectDaemonSelfMount`) plus its
 *  declared protocol. Only ACP adapters model `session/new.mcpServers` at
 *  all, so a non-ACP adapter (`print` / `proprietary`) can never reach the
 *  gateway even on request. */
function classifyDaemonMount(adapter: AdapterListEntry): "default" | "on-request" | "none" {
  if (adapter.protocol !== "acp") return "none"
  return shouldInjectDaemonSelfMount(adapter.slug, undefined) ? "default" : "on-request"
}

/** Per-adapter reach for each import, from the DEFAULT bundles only
 *  (`defaults.bundles` ∪ `defaults.adapters.<slug>.bundles`, same resolver a
 *  spawn uses). Only ACP adapters can take `mcpServers` at all. Pure. */
export function computeImportedReach(
  importIds: readonly string[],
  adapters: readonly AdapterListEntry[],
  config: AgentprotoConfig,
  bundles: BundlesFile,
): Map<string, Record<string, ImportedMcpReach>> {
  const out = new Map<string, Record<string, ImportedMcpReach>>(importIds.map(id => [id, {}]))
  for (const adapter of adapters) {
    const acp = adapter.protocol === "acp"
    const { bundleIds, daemonMount } = resolveBundleDefaults(config.defaults, adapter.slug, {})
    const active = bundles.bundles.filter(b => bundleIds.includes(b.id))
    const indirect =
      acp &&
      (classifyDaemonMount(adapter) === "default" ||
        daemonMount === true ||
        active.some(b => b.includeDaemon === true))
    const wildcard = active.some(b => b.mcpImports === "*")
    const named = new Set(active.flatMap(b => (b.mcpImports === "*" ? [] : b.mcpImports)))
    for (const id of importIds) {
      out.get(id)![adapter.slug] =
        acp && (wildcard || named.has(id)) ? "native" : indirect ? "indirect" : "none"
    }
  }
  return out
}

async function buildMcpInventory(
  deps: CapabilitiesInventoryDeps,
  adapters: AdapterListEntry[],
): Promise<CapabilitiesInventoryMcp> {
  const [importedConfig, discovered, aliasSummaries, config, bundlesFile] = await Promise.all([
    (deps.loadImportedMcps ?? loadImportedMcpsReal)(),
    (deps.discoverMcps ?? discoverMcpsReal)(),
    deps.mcpProxy ? deps.mcpProxy.listAliases() : Promise.resolve([]),
    (deps.loadConfig ?? loadConfigReal)().catch((): AgentprotoConfig => ({})),
    (deps.loadBundles ?? loadBundlesReal)().catch((): BundlesFile => ({ version: 1, bundles: [] })),
  ])
  const reachById = computeImportedReach(
    importedConfig.imports.map(e => e.id),
    adapters,
    config,
    bundlesFile,
  )

  const importedIds = new Set(importedConfig.imports.map(e => e.id))
  const aliasByImportId = new Map(aliasSummaries.map(a => [a.importId, a]))

  const liveSessions = deps.registry
    ? deps.registry.list().filter(s => s.status === "running" || s.status === "starting")
    : []

  const imported: CapabilitiesInventoryImportedMcp[] = importedConfig.imports.map(entry => {
    const alias = aliasByImportId.get(entry.id)
    const status: CapabilitiesInventoryImportedMcp["status"] = !deps.mcpProxy
      ? "unknown"
      : alias?.status === "connected"
        ? "connected"
        : alias?.status === "error"
          ? "error"
          : "idle"
    const usedBySessions = liveSessions
      .filter(s => (s.mcpServers ?? []).some(m => m.name === entry.alias || m.name === entry.id))
      .map(s => s.id)
    return {
      id: entry.id,
      ...(entry.alias !== entry.snapshot.name ? { alias: entry.alias } : {}),
      name: entry.snapshot.name,
      type: entry.snapshot.type,
      source: entry.snapshot.source,
      status,
      ...(alias?.lastError ? { error: alias.lastError } : {}),
      ...(status === "connected" ? { toolCount: alias?.toolCount ?? 0 } : {}),
      usedBySessions,
      ...(entry.resolve ? { resolve: entry.resolve } : {}),
      ...(alias?.stale ? { stale: alias.stale } : {}),
      ...(secretRefKeys(entry) ? { secretRefKeys: secretRefKeys(entry) } : {}),
      reach: reachById.get(entry.id) ?? {},
    }
  })

  const discoveredOut: CapabilitiesInventoryDiscoveredMcp[] = discovered.map(m => ({
    id: m.id,
    source: m.source,
    scope: m.scope,
    name: m.name,
    type: m.type,
    imported: importedIds.has(m.id),
  }))

  const daemonMountByHarness: Record<string, "default" | "on-request" | "none"> = {}
  for (const adapter of adapters) {
    daemonMountByHarness[adapter.slug] = classifyDaemonMount(adapter)
  }

  return { imported, discovered: discoveredOut, daemonMountByHarness }
}

// ── skills block ───────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort()
  } catch {
    return []
  }
}

/** A "pack" is `<dir>/skills/<slug>/`, one folder per skill — same layout
 *  `packages/cli/src/commands/skill-install/pack-resolve.ts`'s `listSkills`
 *  reads for install. Only the directory names are surfaced here (no
 *  SKILL.md frontmatter parse) — this is a discovery inventory, not the
 *  install path. */
async function packSkills(packDir: string): Promise<string[]> {
  return listSubdirs(join(packDir, "skills"))
}

async function scanInstalledPacks(): Promise<SkillPackInventoryEntry[]> {
  const packsDir = join(homedir(), ".agentproto", "packs")
  let entries: string[]
  try {
    entries = await readdir(packsDir)
  } catch {
    return []
  }
  const out: SkillPackInventoryEntry[] = []
  for (const entry of entries) {
    const packDir = join(packsDir, entry)
    try {
      const st = await stat(packDir)
      if (!st.isDirectory()) continue
    } catch {
      continue
    }
    const at = entry.lastIndexOf("@")
    const name = at > 0 ? entry.slice(0, at) : entry
    const version = at > 0 ? entry.slice(at + 1) : undefined
    out.push({
      name,
      ...(version ? { version } : {}),
      path: packDir,
      skills: await packSkills(packDir),
    })
  }
  return out
}

/** Local dev convenience: a repo checked out with its own `.skills/<name>/`
 *  packs (this repo's own default pack, before it's published) — found by
 *  walking up from this module's own file, same technique
 *  `pack-resolve.ts`'s `findRepoRoot` uses. Silently empty outside a repo
 *  checkout (a production install has no `.skills/` above it). */
async function scanRepoSkillsPacks(): Promise<SkillPackInventoryEntry[]> {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, ".skills")
    try {
      const st = await stat(candidate)
      if (st.isDirectory()) {
        const names = await listSubdirs(candidate)
        return Promise.all(
          names.map(async name => {
            const packDir = join(candidate, name)
            return { name, path: packDir, skills: await packSkills(packDir) }
          }),
        )
      }
    } catch {
      // not found at this level
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return []
}

const slugToCamel = (slug: string): string =>
  slug.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase())

/** Dynamically import an already-installed adapter package and duck-type
 *  its manifest export — same lookup order (`mod[camelSlug] ?? mod.default
 *  ?? mod.handle`) `role-registry.ts`'s adapter-carried role discovery
 *  uses. Never throws: an adapter package that fails to import just gets
 *  no `target`/`spawnOption` below, same "partial discovery beats a failed
 *  whole listing" stance as everywhere else in this file. */
async function readAdapterManifest(adapter: AdapterListEntry): Promise<Record<string, unknown> | undefined> {
  try {
    const mod: unknown = await import(adapter.packageName)
    if (!isRecord(mod)) return undefined
    const candidate = mod[slugToCamel(adapter.slug)] ?? mod.default ?? mod.handle
    return isRecord(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

interface SkillsTargetShape {
  format: string
  dir?: string
  outDir?: string
  unit?: string
}

function asSkillsTarget(value: unknown): SkillsTargetShape | undefined {
  if (!isRecord(value) || typeof value.format !== "string") return undefined
  const out: SkillsTargetShape = { format: value.format }
  if (typeof value.dir === "string") out.dir = value.dir
  if (typeof value.outDir === "string") out.outDir = value.outDir
  if (typeof value.unit === "string") out.unit = value.unit
  return out
}

async function listInstalledForTarget(target: SkillsTargetShape): Promise<string[]> {
  // claude-plugin copies the WHOLE pack (including its own `skills/<slug>/`
  // layout) into `outDir` — so the installed set lives at `outDir/skills`,
  // same convention as `packSkills`. flat-dir copies one subdir per skill
  // straight into `dir`.
  const base =
    target.format === "claude-plugin"
      ? target.outDir
        ? join(expandHome(target.outDir), "skills")
        : undefined
      : target.dir
        ? expandHome(target.dir)
        : undefined
  return base ? listSubdirs(base) : []
}

/** Skills a harness discovers on its own, independent of the
 *  `metadata.skills` fan-out target — today only claude-code (`~/.claude/
 *  skills`, a plain per-skill folder convention unrelated to its plugin
 *  install dir). No other adapter in this repo declares a native
 *  discovery path. */
async function listNativeSkills(adapter: AdapterListEntry): Promise<string[]> {
  if (adapter.slug !== "claude-code") return []
  return listSubdirs(join(homedir(), ".claude", "skills"))
}

async function buildHarnessEntry(adapter: AdapterListEntry): Promise<SkillsByHarnessEntry> {
  const manifest = await readAdapterManifest(adapter)
  const metadata = manifest && isRecord(manifest.metadata) ? manifest.metadata : undefined
  const target = asSkillsTarget(metadata?.skills)
  const options = manifest && Array.isArray(manifest.options) ? manifest.options : []
  const spawnOption = options.some(o => isRecord(o) && o.id === "skills")
  const [installed, native] = await Promise.all([
    target ? listInstalledForTarget(target) : Promise.resolve<string[]>([]),
    listNativeSkills(adapter),
  ])
  return {
    adapter: adapter.slug,
    ...(target
      ? {
          target: {
            format: target.format,
            dir: (target.format === "claude-plugin" ? target.outDir : target.dir) ?? "",
            ...(target.unit ? { unit: target.unit } : {}),
          },
        }
      : {}),
    installed,
    native,
    spawnOption,
  }
}

async function buildSkillsInventory(
  adapters: AdapterListEntry[],
  loadConfig: () => Promise<AgentprotoConfig>,
): Promise<CapabilitiesInventorySkills> {
  const cfg = await loadConfig()
  const defaults = {
    global: cfg.defaults?.skills ?? [],
    byAdapter: Object.fromEntries(
      Object.entries(cfg.defaults?.adapters ?? {})
        .filter(([, v]) => (v.skills?.length ?? 0) > 0)
        .map(([slug, v]) => [slug, v.skills ?? []]),
    ),
  }
  const [installedPacks, repoPacks, byHarness] = await Promise.all([
    scanInstalledPacks(),
    scanRepoSkillsPacks(),
    Promise.all(adapters.map(buildHarnessEntry)),
  ])
  return { packs: [...installedPacks, ...repoPacks], byHarness, defaults }
}

// ── entry point ────────────────────────────────────────────────────────

export async function computeCapabilitiesInventory(
  deps: CapabilitiesInventoryDeps,
): Promise<CapabilitiesInventory> {
  const adapters = deps.listAgentAdapters
    ? await deps.listAgentAdapters().catch(() => [] as AdapterListEntry[])
    : []
  const [mcp, skills] = await Promise.all([
    buildMcpInventory(deps, adapters).catch(err => ({
      ...EMPTY_MCP,
      error: err instanceof Error ? err.message : String(err),
    })),
    buildSkillsInventory(adapters, deps.loadConfig ?? loadConfigReal).catch(err => ({
      ...EMPTY_SKILLS,
      error: err instanceof Error ? err.message : String(err),
    })),
  ])
  return { mcp, skills }
}
