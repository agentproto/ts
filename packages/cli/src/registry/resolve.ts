/**
 * Resolve a slug like "claude-code" to a runnable `AgentCliHandle`.
 *
 * Resolution order:
 *   1. `@agentproto/adapter-<slug>` from npm (must default-export or
 *      named-export an `AgentCliHandle` — convention is the camelCased
 *      slug, e.g. `claudeCode`).
 *   2. (TODO) `~/.agentproto/adapters/<slug>/AGENT-CLI.md` on disk.
 *   3. (TODO) bundled fallbacks for the canonical adapters.
 *
 * Step 1 covers 100% of v0 usage. The on-disk path is only there for
 * users authoring their own adapters; we'll add it once `defineAgentCli`
 * supports MD-source authoring end to end.
 */

import { promises as fs } from "node:fs"
import { resolve as resolvePath } from "node:path"
import type { AgentCliHandle } from "@agentproto/driver-agent-cli"

export interface ResolvedAdapter {
  readonly slug: string
  readonly handle: AgentCliHandle
  readonly source: "npm" | "file" | "bundled"
  readonly packageName?: string
}

/**
 * Compact metadata about an installed adapter — the shape returned
 * by `listInstalledAdapters()` and exposed via the daemon's
 * `GET /adapters` route + `list_adapters` MCP tool. Only fields
 * safe to surface in a UI list (no install scripts, no env keys).
 * For full handle access call `resolveAdapter(slug)`.
 */
export interface AdapterInfo {
  slug: string
  /** Display name from the manifest. */
  name: string
  /** Adapter package version (matches npm package.json `version`). */
  version: string
  /** One-line user-facing description. */
  description: string
  /** Wire protocol — informs prompt/multi-turn semantics. */
  protocol: string
  /** True when the adapter advertises a streaming session contract. */
  streaming: boolean
  /** npm package name (for install hints / "open in npmjs.com" links). */
  packageName: string
}

const slugToCamel = (slug: string): string =>
  slug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())

export async function resolveAdapter(slug: string): Promise<ResolvedAdapter> {
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    throw new Error(
      `agentproto: invalid adapter slug '${slug}'. Slugs are lower-kebab.`
    )
  }

  const packageName = `@agentproto/adapter-${slug}`
  let mod: Record<string, unknown>
  try {
    mod = (await import(packageName)) as Record<string, unknown>
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new Error(
      `agentproto: could not load adapter '${slug}'. ` +
        `Tried '${packageName}'. Install it with: npm i -g ${packageName}\n  cause: ${cause}`
    )
  }

  const camel = slugToCamel(slug)
  const candidate =
    (mod[camel] as AgentCliHandle | undefined) ??
    (mod.default as AgentCliHandle | undefined) ??
    (mod.handle as AgentCliHandle | undefined)

  if (!candidate || typeof candidate !== "object" || !("name" in candidate)) {
    throw new Error(
      `agentproto: adapter '${packageName}' does not export an AgentCliHandle ` +
        `(looked for export '${camel}', 'default', or 'handle').`
    )
  }

  return { slug, handle: candidate, source: "npm", packageName }
}

/**
 * Enumerate every `@agentproto/adapter-*` package reachable from the
 * current node module-resolution path. Used by the daemon's
 * `GET /adapters` route and `list_adapters` MCP tool so UIs (web
 * spawn dialog) and operators can pick from the installed set
 * without trial-and-error against `resolveAdapter(slug)`.
 *
 * Implementation: walk `node_modules/@agentproto` looking for
 * `adapter-*` directories; for each, dynamic-import the package +
 * extract the AgentCliHandle's display fields. Failures (broken
 * exports, missing dist) are collected as warnings rather than
 * thrown — partial discovery beats failing the whole listing on
 * one bad adapter.
 *
 * Discovery is async + reads disk on every call; cache at the
 * caller layer if you list often. v0 does no caching here because
 * adapter sets typically change rarely (npm i / rm) and a fresh
 * scan stays fast (~10 packages worth of dynamic imports).
 */
export async function listInstalledAdapters(opts?: {
  /** Override the search root. Defaults to walking up from the cli
   *  package's own location until we hit a `node_modules/@agentproto`. */
  searchRoot?: string
}): Promise<AdapterInfo[]> {
  const roots = await collectAgentprotoNamespaceRoots(opts?.searchRoot)
  const seen = new Set<string>()
  const out: AdapterInfo[] = []

  for (const root of roots) {
    let entries: string[] = []
    try {
      entries = await fs.readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.startsWith("adapter-")) continue
      const slug = entry.slice("adapter-".length)
      if (seen.has(slug)) continue
      seen.add(slug)
      try {
        const resolved = await resolveAdapter(slug)
        const handle = resolved.handle as Record<string, unknown>
        const info: AdapterInfo = {
          slug,
          name: typeof handle.name === "string" ? handle.name : slug,
          version: typeof handle.version === "string" ? handle.version : "?",
          description:
            typeof handle.description === "string" ? handle.description : "",
          protocol:
            typeof handle.protocol === "string" ? handle.protocol : "unknown",
          streaming: !!(handle.capabilities as { streaming?: boolean })
            ?.streaming,
          packageName: resolved.packageName ?? `@agentproto/adapter-${slug}`,
        }
        out.push(info)
      } catch (err) {
        // Broken adapter — log and skip rather than fail the listing.
        console.warn(
          `[agentproto/cli] listInstalledAdapters: skipping broken adapter '${slug}': ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * Walk up from the cli package looking for `node_modules/@agentproto`
 * directories. Returns every match (pnpm + global + nvm hoisting can
 * produce more than one) so adapters installed in any reachable
 * scope are discoverable.
 */
async function collectAgentprotoNamespaceRoots(
  start?: string
): Promise<string[]> {
  const roots: string[] = []
  // Start from this package's own dir — works in ESM (import.meta.url
  // route would be cleaner but isn't needed; cwd is reliable enough
  // for the daemon use case where it boots from a known dir).
  let cur = start ?? process.cwd()
  // Both classic + pnpm-hoist locations. Classic npm puts the
  // namespace at node_modules/@agentproto; pnpm hoists to
  // node_modules/.pnpm/node_modules/@agentproto and symlinks
  // individual packages from there. We need to scan the hoist dir
  // for the listing because the namespace dir is the only place
  // where every adapter package is enumerable.
  const candidatesAt = (dir: string): string[] => [
    resolvePath(dir, "node_modules", "@agentproto"),
    resolvePath(dir, "node_modules", ".pnpm", "node_modules", "@agentproto"),
  ]
  for (let depth = 0; depth < 16; depth++) {
    for (const candidate of candidatesAt(cur)) {
      try {
        const stat = await fs.stat(candidate)
        if (stat.isDirectory()) roots.push(candidate)
      } catch {
        /* not present at this level */
      }
    }
    const parent = resolvePath(cur, "..")
    if (parent === cur) break
    cur = parent
  }
  return roots
}
