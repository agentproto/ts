/**
 * resolveImportConnection — the ONE place an imported-MCP entry becomes a
 * connection config. Both connection paths call it: `McpProxyRegistry`
 * (daemon `/mcp` proxy + `/mcp/imported/<id>` native mounts) and
 * `resolveMcpServer` step 4 (MCP Apps host), so credentials and header
 * handling cannot diverge between them.
 *
 * P1 semantics:
 *   - `resolve: "snapshot"` (or absent — legacy entries) → the stored
 *     snapshot.
 *   - `resolve: "live"` → re-read discovery: exact `id` match, else a
 *     same-`source+scope` match by normalized url / command+args (heals a
 *     rename at the source; the new name is REPORTED as `origin`, the file
 *     is never rewritten here), else the snapshot + `stale`.
 *     Live values win for url/command/args/headers/env.
 *   - `secretRefs` are resolved LAST through `deps.resolveMcpSecret` into
 *     the SAME key (secret wins over live/snapshot). A ref that cannot be
 *     resolved never leaks the `<secretRef>` marker: the key is dropped and
 *     `stale.reason` names it (key names only, never values).
 */

import { homedir } from "node:os"
import { resolve as resolvePath } from "node:path"
import type { McpConnectionConfig } from "./mcp-client-pool.js"
import type { McpCredentialDeps } from "./mcp-credential-deps.js"
import { discoverMcps, type DiscoveredMcp } from "./mcp-discovery.js"
import {
  SECRET_REF_MARKER,
  type ImportedMcpEntry,
  type ImportedMcpOrigin,
} from "./mcp-imports.js"
import { loadWorkspacesConfig } from "./workspaces-config.js"

export interface ResolvedImportConnection {
  config: McpConnectionConfig
  /** Set when the entry could not be resolved against its live source. */
  stale?: { reason: string }
  /** Set when a live rename was auto-healed (in memory only). */
  origin?: ImportedMcpOrigin
}

/** The connection-relevant slice of a discovered/snapshotted server. */
export function connectionOf(m: DiscoveredMcp): McpConnectionConfig {
  return {
    type: m.type,
    ...(m.command !== undefined ? { command: m.command } : {}),
    ...(m.args !== undefined ? { args: m.args } : {}),
    ...(m.env !== undefined ? { env: m.env } : {}),
    ...(m.url !== undefined ? { url: m.url } : {}),
    ...(m.headers !== undefined ? { headers: m.headers } : {}),
  }
}


export interface ResolveImportOptions {
  /** Override discovery (tests). */
  discover?: () => Promise<DiscoveredMcp[]>
  home?: string
}

const warnedOrigin = new Set<string>()

function normUrl(u: string | undefined): string | undefined {
  if (!u) return undefined
  try {
    const x = new URL(u)
    return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, "")}`
  } catch {
    return u.replace(/\/+$/, "")
  }
}

function sameUpstream(a: DiscoveredMcp, b: DiscoveredMcp): boolean {
  const ua = normUrl(a.url)
  const ub = normUrl(b.url)
  if (ua && ub) return ua === ub
  if (a.command && b.command) {
    return (
      a.command === b.command &&
      JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? [])
    )
  }
  return false
}

/**
 * Files whose mtime signals that a `live` entry's source changed.
 * claude-code / cursor / codex → the harness's global config; workspace →
 * the registered workspace's candidate `.mcp.json` files.
 */
export async function liveSourcePaths(
  entry: ImportedMcpEntry,
  home: string = homedir()
): Promise<string[]> {
  const src = entry.snapshot.source
  if (src === "claude-code") return [resolvePath(home, ".claude.json")]
  if (src === "cursor") return [resolvePath(home, ".cursor", "mcp.json")]
  if (src === "codex") return [resolvePath(home, ".codex", "config.toml")]
  if (src === "workspace") {
    const slug = entry.snapshot.scope.replace(/^workspace:/, "")
    try {
      const cfg = await loadWorkspacesConfig()
      const ws = cfg.workspaces.find(w => w.slug === slug)
      if (!ws) return []
      return [
        resolvePath(ws.path, ".mcp.json"),
        resolvePath(ws.path, ".cursor", "mcp.json"),
        resolvePath(ws.path, ".vscode", "mcp.json"),
      ]
    } catch {
      return []
    }
  }
  return []
}

export async function resolveImportConnection(
  entry: ImportedMcpEntry,
  deps?: McpCredentialDeps,
  opts: ResolveImportOptions = {}
): Promise<ResolvedImportConnection> {
  let base: DiscoveredMcp = entry.snapshot
  let stale: { reason: string } | undefined
  let origin: ImportedMcpOrigin | undefined

  if (entry.resolve === "live") {
    let found: DiscoveredMcp | undefined
    try {
      const all = await (opts.discover ?? (() => discoverMcps(opts.home ? { home: opts.home } : {})))()
      found = all.find(m => m.id === entry.snapshot.id)
      if (!found) {
        const cands = all.filter(
          m =>
            m.source === entry.snapshot.source &&
            m.scope === entry.snapshot.scope &&
            sameUpstream(m, entry.snapshot)
        )
        if (cands.length === 1) {
          found = cands[0]
          origin = {
            kind: found!.source,
            scope: found!.scope,
            name: found!.name,
          }
        }
      }
    } catch {
      found = undefined
    }
    if (found) {
      base = found
      if (
        entry.secretRefs &&
        normUrl(found.url) !== normUrl(entry.snapshot.url) &&
        !warnedOrigin.has(entry.id)
      ) {
        warnedOrigin.add(entry.id)
        console.warn(
          `[mcp-import] "${entry.alias}": live source now points at a different upstream than at import time; stored secrets are unchanged (re-import to rotate)`
        )
      }
    } else {
      stale = { reason: "source-entry-missing" }
    }
  }

  const config = { ...connectionOf(base) }
  const refs = entry.secretRefs
  if (refs) {
    const unresolved: string[] = []
    const resolveOne = async (ref: string): Promise<string | undefined> => {
      try {
        return deps?.resolveMcpSecret ? await deps.resolveMcpSecret(ref) : undefined
      } catch {
        return undefined
      }
    }
    if (refs.headers) {
      const headers: Record<string, string> = { ...(config.headers ?? {}) }
      for (const [key, ref] of Object.entries(refs.headers)) {
        const value = await resolveOne(ref)
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === key.toLowerCase()) delete headers[k]
        }
        if (value !== undefined) headers[key] = value
        else {
          // Fall back to the live/snapshot value unless it is the marker.
          const fallback = (base.headers ?? {})[key]
          if (fallback !== undefined && fallback !== SECRET_REF_MARKER) headers[key] = fallback
          else unresolved.push(`headers.${key}`)
        }
      }
      config.headers = headers
    }
    if (refs.env) {
      const env: Record<string, string> = { ...(config.env ?? {}) }
      for (const [key, ref] of Object.entries(refs.env)) {
        const value = await resolveOne(ref)
        if (value !== undefined) env[key] = value
        else {
          const fallback = (base.env ?? {})[key]
          if (fallback !== undefined && fallback !== SECRET_REF_MARKER) env[key] = fallback
          else {
            delete env[key]
            unresolved.push(`env.${key}`)
          }
        }
      }
      config.env = env
    }
    if (unresolved.length > 0) {
      const why = `secret-unresolved: ${unresolved.join(", ")}`
      stale = { reason: stale ? `${stale.reason}; ${why}` : why }
    }
  }

  return {
    config,
    ...(stale ? { stale } : {}),
    ...(origin ? { origin } : {}),
  }
}
