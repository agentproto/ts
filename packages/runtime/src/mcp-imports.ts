/**
 * `~/.agentproto/imported-mcps.json` — the user's curated set of
 * discovered MCPs they want the daemon to know about. v1 is just
 * persistence + read-side; the actual MCP-proxy implementation
 * (where the daemon's /mcp endpoint aggregates the imported
 * servers' tools under namespace prefixes) is v2 work.
 *
 * Purpose: today, "I see you have chrome-devtools in claude" is
 * read-only. Once a user imports it, the operator agent can refer
 * to it ("the user said it's enabled — call it") and a future
 * proxy layer can actually expose it. We persist the choice now so
 * the data is in place when the proxy lands.
 *
 * File shape:
 *   {
 *     "version": 1,
 *     "imports": [
 *       {
 *         "id":         "claude-code:project:/path:chrome-devtools",
 *         "alias":      "chrome-devtools",
 *         "addedAt":    "2026-05-10T...",
 *         "snapshot":   { ...the DiscoveredMcp at import time }
 *       }
 *     ]
 *   }
 *
 * Snapshotting at import time keeps the daemon resilient to the
 * source config getting deleted (user runs `claude mcp remove ...`).
 * The imported entry stays usable; only the next discovery pass
 * stops listing it as "available to import."
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve as resolvePath } from "node:path"
import type { DiscoveredMcp } from "./mcp-discovery.js"

export const IMPORTED_MCPS_PATH = (): string =>
  resolvePath(homedir(), ".agentproto", "imported-mcps.json")

export const IMPORTED_MCPS_VERSION = 1 as const

/** Where an import came from. `plugin` (written by plugin-local-browser) and
 *  `manual` have no discovery source; `kind` otherwise mirrors
 *  `DiscoveredMcp["source"]`. */
export interface ImportedMcpOrigin {
  kind: DiscoveredMcp["source"] | "plugin" | "manual"
  scope: string
  name: string
}

/** `live` = re-read the source harness config at connect time (the snapshot is
 *  only a fallback); `snapshot` = the stored copy is authoritative. */
export type ImportedMcpResolve = "live" | "snapshot"

/** Opaque secret refs (resolved via `resolveMcpSecret`), keyed by the header
 *  / env key they fill. Values are refs, NEVER secret material. */
export interface ImportedMcpSecretRefs {
  headers?: Record<string, string>
  env?: Record<string, string>
}

export interface ImportedMcpEntry {
  id: string
  alias: string
  addedAt: string
  snapshot: DiscoveredMcp
  /** Additive (no file-version bump): link back to the source config. */
  origin?: ImportedMcpOrigin
  resolve?: ImportedMcpResolve
  secretRefs?: ImportedMcpSecretRefs
}

/** Value written into `snapshot.headers[K]` / `snapshot.env[K]` in place of a
 *  literal secret that now lives behind `secretRefs`. */
export const SECRET_REF_MARKER = "<secretRef>"

/** Discovery sources whose config can be re-read live. */
const LIVE_SOURCES: ReadonlySet<string> = new Set([
  "claude-code",
  "cursor",
  "codex",
  "workspace",
])

/** `live` only when discovery can actually re-find the entry: a discovery
 *  source AND a scope discovery scans (`global` / `project:*` / `workspace:*`).
 *  claude-code `local`-scope and plugin/manual entries stay `snapshot`. */
export function deriveResolve(snapshot: DiscoveredMcp): ImportedMcpResolve {
  if (!LIVE_SOURCES.has(snapshot.source)) return "snapshot"
  const s = snapshot.scope
  return s === "global" || s.startsWith("project:") || s.startsWith("workspace:")
    ? "live"
    : "snapshot"
}

/** Keychain path + account for one secret slot of an import. Ref format
 *  `agentproto/mcp-import/<importId>#<header|env>:<KEY>` (split on LAST `#`). */
export function mcpSecretRef(
  importId: string,
  kind: "header" | "env",
  key: string
): string {
  return `agentproto/mcp-import/${importId}#${kind}:${key}`
}

const PLACEHOLDER_RE = /\$\{[A-Z_][A-Z0-9_]*(?::-[^}]*)?\}/i

/** A value worth moving to the keychain: non-empty, not already the marker,
 *  and not a `${VAR}` placeholder (those expand at connect, no secret at rest). */
export function isLiteralSecretValue(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v !== SECRET_REF_MARKER &&
    !PLACEHOLDER_RE.test(v)
  )
}

export interface MoveSecretsResult {
  entry: ImportedMcpEntry
  /** Header/env KEY names moved this call (never values). */
  moved: string[]
  /** Human warnings (key names only). */
  warnings: string[]
}

/**
 * Move every literal header/env value of `entry.snapshot` behind a keychain
 * ref. Keychain write happens FIRST per key; only on success is the snapshot
 * value replaced by the marker (a failed write keeps the literal + warns).
 * Read-back verification when `resolve` is supplied.
 */
export async function moveEntrySecrets(
  entry: ImportedMcpEntry,
  hooks: {
    storeMcpSecret?: (ref: string, value: string) => Promise<void>
    resolveMcpSecret?: (ref: string) => Promise<string | undefined>
  }
): Promise<MoveSecretsResult> {
  if (!hooks.storeMcpSecret) {
    const has =
      Object.values(entry.snapshot.headers ?? {}).some(isLiteralSecretValue) ||
      Object.values(entry.snapshot.env ?? {}).some(isLiteralSecretValue)
    return {
      entry,
      moved: [],
      warnings: has
        ? [
            "no secret store available: header/env values were kept as literals in imported-mcps.json (mode 0600)",
          ]
        : [],
    }
  }
  const moved: string[] = []
  const warnings: string[] = []
  const secretRefs: ImportedMcpSecretRefs = {
    ...(entry.secretRefs?.headers ? { headers: { ...entry.secretRefs.headers } } : {}),
    ...(entry.secretRefs?.env ? { env: { ...entry.secretRefs.env } } : {}),
  }
  const headers = entry.snapshot.headers ? { ...entry.snapshot.headers } : undefined
  const env = entry.snapshot.env ? { ...entry.snapshot.env } : undefined
  const passes: Array<["header" | "env", Record<string, string> | undefined]> = [
    ["header", headers],
    ["env", env],
  ]
  for (const [kind, map] of passes) {
    if (!map) continue
    for (const [key, value] of Object.entries(map)) {
      if (!isLiteralSecretValue(value)) continue
      const ref = mcpSecretRef(entry.id, kind, key)
      try {
        await hooks.storeMcpSecret(ref, value)
        if (hooks.resolveMcpSecret) {
          const back = await hooks.resolveMcpSecret(ref)
          if (back !== value) throw new Error("read-back mismatch")
        }
      } catch (err) {
        warnings.push(
          `could not store ${kind} "${key}" in the secret store (${
            err instanceof Error ? err.message : "error"
          }); kept as a literal`
        )
        continue
      }
      map[key] = SECRET_REF_MARKER
      const bucket = kind === "header" ? "headers" : "env"
      secretRefs[bucket] = { ...(secretRefs[bucket] ?? {}), [key]: ref }
      moved.push(`${kind}:${key}`)
    }
  }
  if (moved.length === 0) return { entry, moved, warnings }
  return {
    entry: {
      ...entry,
      snapshot: {
        ...entry.snapshot,
        ...(headers ? { headers } : {}),
        ...(env ? { env } : {}),
      },
      secretRefs,
    },
    moved,
    warnings,
  }
}

export interface ImportedMcpsConfig {
  version: typeof IMPORTED_MCPS_VERSION
  imports: ImportedMcpEntry[]
}

const EMPTY: ImportedMcpsConfig = {
  version: IMPORTED_MCPS_VERSION,
  imports: [],
}

export async function loadImportedMcps(
  path: string = IMPORTED_MCPS_PATH()
): Promise<ImportedMcpsConfig> {
  let raw: string
  try {
    raw = await fs.readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `agentproto: ${path} is not valid JSON (${
        err instanceof Error ? err.message : String(err)
      }). Delete or fix manually.`
    )
  }
  return normalize(parsed)
}

export async function saveImportedMcps(
  config: ImportedMcpsConfig,
  path: string = IMPORTED_MCPS_PATH()
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  // 0600: entries may hold literal upstream credentials (parity with bundles.ts).
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
  await fs.rename(tmp, path)
}

/**
 * Add (or replace) an import. Snapshots the discovered MCP at
 * import time so the entry stays usable when the source config
 * disappears.
 */
export function addImport(
  config: ImportedMcpsConfig,
  input: { snapshot: DiscoveredMcp; alias?: string }
): ImportedMcpsConfig {
  const alias = (input.alias ?? input.snapshot.name).trim()
  if (!alias) {
    throw new Error("addImport: alias resolves to empty string")
  }
  const addedAt = new Date().toISOString()
  const next: ImportedMcpEntry = {
    id: input.snapshot.id,
    alias,
    addedAt,
    snapshot: input.snapshot,
    origin: {
      kind: input.snapshot.source,
      scope: input.snapshot.scope,
      name: input.snapshot.name,
    },
    resolve: deriveResolve(input.snapshot),
  }
  const others = config.imports.filter(e => e.id !== input.snapshot.id)
  return { ...config, imports: [...others, next] }
}

/**
 * `addImport` + move literal header/env values behind keychain refs (via the
 * `storeMcpSecret` hook). Hook absent → literals kept and a warning returned.
 * Callers persist `config` and surface `warnings` in their reply.
 */
export async function addImportWithSecrets(
  config: ImportedMcpsConfig,
  input: { snapshot: DiscoveredMcp; alias?: string },
  hooks: {
    storeMcpSecret?: (ref: string, value: string) => Promise<void>
    resolveMcpSecret?: (ref: string) => Promise<string | undefined>
  }
): Promise<{ config: ImportedMcpsConfig; entry: ImportedMcpEntry; warnings: string[] }> {
  const added = addImport(config, input)
  const entry = added.imports.find(e => e.id === input.snapshot.id)!
  const moved = await moveEntrySecrets(entry, hooks)
  return {
    config: {
      ...added,
      imports: added.imports.map(e => (e.id === entry.id ? moved.entry : e)),
    },
    entry: moved.entry,
    warnings: moved.warnings,
  }
}

export function removeImport(
  config: ImportedMcpsConfig,
  id: string
): ImportedMcpsConfig {
  return { ...config, imports: config.imports.filter(e => e.id !== id) }
}

export function findImport(
  config: ImportedMcpsConfig,
  id: string
): ImportedMcpEntry | undefined {
  return config.imports.find(e => e.id === id)
}

function normalize(parsed: unknown): ImportedMcpsConfig {
  if (!parsed || typeof parsed !== "object") return EMPTY
  const obj = parsed as Record<string, unknown>
  const imports: ImportedMcpEntry[] = []
  if (Array.isArray(obj.imports)) {
    for (const entry of obj.imports) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      const id = typeof e.id === "string" ? e.id : ""
      const alias = typeof e.alias === "string" ? e.alias : id
      const addedAt =
        typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString()
      const snapshot = e.snapshot as DiscoveredMcp | undefined
      if (!id || !snapshot) continue
      const extra: Partial<ImportedMcpEntry> = {}
      const origin = parseOrigin(e.origin)
      if (origin) extra.origin = origin
      if (e.resolve === "live" || e.resolve === "snapshot") extra.resolve = e.resolve
      const secretRefs = parseSecretRefs(e.secretRefs)
      if (secretRefs) extra.secretRefs = secretRefs
      imports.push({ id, alias, addedAt, snapshot, ...extra })
    }
  }
  return { version: IMPORTED_MCPS_VERSION, imports }
}

function parseOrigin(v: unknown): ImportedMcpOrigin | undefined {
  if (!v || typeof v !== "object") return undefined
  const o = v as Record<string, unknown>
  if (
    typeof o.kind !== "string" ||
    typeof o.scope !== "string" ||
    typeof o.name !== "string"
  )
    return undefined
  return { kind: o.kind as ImportedMcpOrigin["kind"], scope: o.scope, name: o.name }
}

function parseStringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseSecretRefs(v: unknown): ImportedMcpSecretRefs | undefined {
  if (!v || typeof v !== "object") return undefined
  const o = v as Record<string, unknown>
  const headers = parseStringMap(o.headers)
  const env = parseStringMap(o.env)
  if (!headers && !env) return undefined
  return { ...(headers ? { headers } : {}), ...(env ? { env } : {}) }
}

/** KEY names only (never refs' targets or values) — for status surfaces. */
export function secretRefKeys(
  entry: Pick<ImportedMcpEntry, "secretRefs">
): { headers?: string[]; env?: string[] } | undefined {
  const r = entry.secretRefs
  if (!r) return undefined
  const headers = r.headers ? Object.keys(r.headers) : []
  const env = r.env ? Object.keys(r.env) : []
  if (headers.length === 0 && env.length === 0) return undefined
  return {
    ...(headers.length ? { headers } : {}),
    ...(env.length ? { env } : {}),
  }
}
