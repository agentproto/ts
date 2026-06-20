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
import { fileURLToPath } from "node:url"
import { dirname, join, resolve as resolvePath } from "node:path"
import { homedir } from "node:os"
import type { AgentCliHandle } from "@agentproto/driver-agent-cli"

/** Slash-command declared in an adapter manifest (AIP-45 `commands[]`). */
export interface AgentCliCommand {
  name: string
  description?: string
}

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
  /** Slash-commands the agent CLI accepts as ordinary text turns.
   *  Empty when the adapter doesn't declare any. */
  commands: AgentCliCommand[]
  /** Known-valid model identifiers for this adapter, drawn from the
   *  adapter manifest's `models.allowed` field. Empty when the adapter
   *  doesn't declare a model list (accepts whatever the underlying
   *  binary accepts). Pass one of these as `model` in `start_agent_session`
   *  to avoid trial-and-error validation errors. */
  models: string[]
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
  const camel = slugToCamel(slug)
  let mod: Record<string, unknown>
  let resolvedPackageName = packageName
  try {
    mod = (await import(packageName)) as Record<string, unknown>
  } catch (primaryErr) {
    // Fallback: strip the last hyphen-segment and try the parent package,
    // looking for the full camelCase export there.
    // e.g. "claude-code-print" → "@agentproto/adapter-claude-code" + export "claudeCodePrint"
    const hyphen = slug.lastIndexOf("-")
    if (hyphen > 0) {
      const parentPkg = `@agentproto/adapter-${slug.slice(0, hyphen)}`
      try {
        const parentMod = (await import(parentPkg)) as Record<string, unknown>
        const parentCandidate = parentMod[camel] as AgentCliHandle | undefined
        if (
          parentCandidate &&
          typeof parentCandidate === "object" &&
          "name" in parentCandidate
        ) {
          return { slug, handle: parentCandidate, source: "npm", packageName: parentPkg }
        }
      } catch {
        /* parent also missing — fall through to original error */
      }
    }

    const cause = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
    throw new Error(
      `agentproto: could not load adapter '${slug}'. ` +
        `Tried '${packageName}'. Install it with: npm i -g ${packageName}\n  cause: ${cause}`
    )
  }

  const candidate =
    (mod[camel] as AgentCliHandle | undefined) ??
    (mod.default as AgentCliHandle | undefined) ??
    (mod.handle as AgentCliHandle | undefined)

  if (!candidate || typeof candidate !== "object" || !("name" in candidate)) {
    throw new Error(
      `agentproto: adapter '${resolvedPackageName}' does not export an AgentCliHandle ` +
        `(looked for export '${camel}', 'default', or 'handle').`
    )
  }

  return { slug, handle: candidate, source: "npm", packageName: resolvedPackageName }
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
  // Two failure buckets so we can produce ONE summary line for the
  // expected case (adapter dir found by the walker but not importable
  // from the daemon's resolution path — i.e. workspace-hoisted, not
  // globally installed) and keep per-adapter warnings only for the
  // genuinely surprising ones (broken exports, missing dist, etc.).
  const notImportable: string[] = []

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
        const modelsField = (handle.models as { allowed?: unknown } | undefined)?.allowed
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
          commands: Array.isArray(handle.commands) ? (handle.commands as AgentCliCommand[]) : [],
          models: Array.isArray(modelsField)
            ? (modelsField as unknown[]).filter((m): m is string => typeof m === "string")
            : [],
        }
        out.push(info)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // ERR_MODULE_NOT_FOUND / "Cannot find package" is the expected
        // shape when the walker finds an adapter dir hoisted in a
        // workspace's node_modules but that dir isn't reachable from
        // the daemon binary's NODE_PATH. Collapse those into a single
        // summary line below; anything else (broken handle export,
        // syntax error in dist, etc.) still warns individually.
        if (
          /Cannot find package|ERR_MODULE_NOT_FOUND/i.test(msg) &&
          msg.includes(`@agentproto/adapter-${slug}`)
        ) {
          notImportable.push(slug)
        } else {
          console.warn(
            `[agentproto/cli] listInstalledAdapters: skipping broken adapter '${slug}': ${msg}`
          )
        }
      }
    }
  }

  // We deliberately do NOT log `notImportable` to console. The
  // discovery walker often finds adapter directories hoisted in a
  // workspace's node_modules that aren't reachable from the daemon's
  // own NODE_PATH — that's a normal state for a fresh checkout and
  // not actionable from a daemon log line. Callers who want the info
  // can inspect the `listInstalledAdapters` return value (importable
  // adapters only); a future `agentproto adapters doctor` verb is the
  // right home for surfacing the unimportable slugs interactively.
  void notImportable

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
  const seen = new Set<string>()
  const roots: string[] = []
  const candidatesAt = (dir: string): string[] => [
    resolvePath(dir, "node_modules", "@agentproto"),
    resolvePath(dir, "node_modules", ".pnpm", "node_modules", "@agentproto"),
  ]

  async function walkUp(from: string): Promise<void> {
    let cur = from
    for (let depth = 0; depth < 20; depth++) {
      if (seen.has(cur)) break
      seen.add(cur)
      for (const candidate of candidatesAt(cur)) {
        try {
          const s = await fs.stat(candidate)
          if (s.isDirectory() && !roots.includes(candidate)) roots.push(candidate)
        } catch { /* not present */ }
      }
      const parent = resolvePath(cur, "..")
      if (parent === cur) break
      cur = parent
    }
  }

  // Walk from the caller-supplied root (or cwd) — covers the workspace root.
  await walkUp(start ?? process.cwd())
  // Also walk from this file's location so pnpm-linked adapters in
  // packages/cli/node_modules/@agentproto/ are found regardless of cwd.
  // Resolves correctly whether running from dist (node file.mjs) or ts-node.
  try {
    await walkUp(dirname(fileURLToPath(import.meta.url)))
  } catch { /* ESM not available in this context */ }

  return roots
}

// ── catalog-aware lister ─────────────────────────────────────────────────────

/** Minimal catalog shape consumed by `listAdaptersWithCatalog`. */
export interface CatalogEntry {
  slug: string
  name: string
  description: string
  packageName: string
  hint?: string
}

/**
 * Enumerate adapters starting from a static catalog and enriching each entry
 * with its runtime availability status:
 *
 *   "supported" — known to agentproto, package not importable (not installed)
 *   "available" — package resolves; setup ledger absent or adapter has no setup
 *   "ready"     — package resolves + setup ledger present
 *
 * Also appends any adapters discovered by `listInstalledAdapters` that aren't
 * in the catalog, so locally-installed custom adapters still appear.
 *
 * This replaces `listInstalledAdapters` as the source for `list_adapters` so
 * the MCP tool always returns the supported set — not just what happens to be
 * discoverable from the daemon's node_modules at that moment.
 */
export async function listAdaptersWithCatalog(
  catalog: readonly CatalogEntry[]
): Promise<(AdapterInfo & { status: "supported" | "available" | "ready"; hint?: string })[]> {
  const seenSlugs = new Set<string>()
  const out: (AdapterInfo & { status: "supported" | "available" | "ready"; hint?: string })[] = []

  const agentprotoHome = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")

  async function hasSetupLedger(slug: string): Promise<boolean> {
    try {
      await fs.access(join(agentprotoHome, "setup", `${slug}.json`))
      return true
    } catch {
      return false
    }
  }

  // Process catalog entries first (preserves catalog order for known adapters).
  for (const entry of catalog) {
    seenSlugs.add(entry.slug)
    try {
      const resolved = await resolveAdapter(entry.slug)
      const handle = resolved.handle as Record<string, unknown>
      const setupSteps = Array.isArray((handle as { setup?: unknown[] }).setup)
        ? (handle as { setup: unknown[] }).setup
        : []
      const ledgerPresent = await hasSetupLedger(entry.slug)
      const status: "available" | "ready" =
        setupSteps.length === 0 || ledgerPresent ? "ready" : "available"
      const catalogModels = (handle.models as { allowed?: unknown } | undefined)?.allowed
      out.push({
        slug: entry.slug,
        name: typeof handle.name === "string" ? handle.name : entry.name,
        version: typeof handle.version === "string" ? handle.version : "?",
        description:
          typeof handle.description === "string" ? handle.description : entry.description,
        protocol: typeof handle.protocol === "string" ? handle.protocol : "unknown",
        streaming: !!(handle.capabilities as { streaming?: boolean })?.streaming,
        packageName: resolved.packageName ?? entry.packageName,
        commands: Array.isArray(handle.commands) ? (handle.commands as AgentCliCommand[]) : [],
        models: Array.isArray(catalogModels)
          ? (catalogModels as unknown[]).filter((m): m is string => typeof m === "string")
          : [],
        status,
        hint: entry.hint,
      })
    } catch {
      // Package not importable — show as "supported" (known but not installed).
      out.push({
        slug: entry.slug,
        name: entry.name,
        version: "not installed",
        description: entry.description,
        protocol: "unknown",
        streaming: false,
        packageName: entry.packageName,
        commands: [],
        models: [],
        status: "supported",
        hint: entry.hint,
      })
    }
  }

  // Append any installed adapters not in the catalog (custom / third-party).
  const installed = await listInstalledAdapters()
  for (const info of installed) {
    if (seenSlugs.has(info.slug)) continue
    seenSlugs.add(info.slug)
    const ledgerPresent = await hasSetupLedger(info.slug)
    out.push({ ...info, status: ledgerPresent ? "ready" : "available" })
  }

  return out
}
