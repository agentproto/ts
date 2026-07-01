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
import { join } from "node:path"
import { homedir } from "node:os"
import type { AgentCliHandle } from "@agentproto/driver-agent-cli"
import {
  makeAdapterResolver,
  makeAdapterLister,
  makeSetupLedger,
  collectAgentprotoNamespaceRoots,
  type AdapterHandle,
  type AdapterCatalogEntry,
} from "@agentproto/adapter-kit"

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
   *  binary accepts). Pass one of these as `model` in `agent_start`
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

// ── catalog-aware lister ─────────────────────────────────────────────────────

/**
 * `AgentCliHandle` wrapped to satisfy the kit's `AdapterHandle` contract.
 * The extra fields (protocol/streaming/commands/models/originalHandle) carry
 * the info the lister needs without requiring the kit to know about the
 * family-specific handle shape.
 */
export interface AgentCliWrappedHandle extends AdapterHandle {
  readonly protocol: string
  readonly streaming: boolean
  readonly commands: AgentCliCommand[]
  readonly models: string[]
  readonly packageName: string
  readonly originalHandle: AgentCliHandle
}

/** Extract the family descriptor from a wrapped handle (never includes secrets). */
type AgentCliInfo = Pick<AdapterInfo, "protocol" | "streaming" | "commands" | "models">

function toAgentCliInfo(h: AgentCliWrappedHandle): AgentCliInfo {
  return {
    protocol: h.protocol,
    streaming: h.streaming,
    commands: h.commands,
    models: h.models,
  }
}

/** Wrap a resolved slug+handle into the kit's `AdapterHandle` shape. */
export function wrapCliHandle(
  slug: string,
  handle: AgentCliHandle,
  packageName: string
): AgentCliWrappedHandle {
  const h = handle as Record<string, unknown>
  const modelsField = (h.models as { allowed?: unknown } | undefined)?.allowed
  return {
    slug,
    name: typeof h.name === "string" ? h.name : slug,
    version: typeof h.version === "string" ? h.version : "?",
    description: typeof h.description === "string" ? h.description : "",
    requiresSetup: Array.isArray(h.setup) && (h.setup as unknown[]).length > 0,
    check: async () => false,
    protocol: typeof h.protocol === "string" ? h.protocol : "unknown",
    streaming: !!(h.capabilities as { streaming?: boolean })?.streaming,
    packageName,
    commands: Array.isArray(h.commands) ? (h.commands as AgentCliCommand[]) : [],
    models: Array.isArray(modelsField)
      ? (modelsField as unknown[]).filter((m): m is string => typeof m === "string")
      : [],
    originalHandle: handle,
  }
}

/** Walk node_modules for adapter slugs not in `catalogSlugs`, resolve each once. */
async function discoverExtraHandles(
  catalogSlugs: Set<string>
): Promise<AgentCliWrappedHandle[]> {
  const roots = await collectAgentprotoNamespaceRoots()
  const seen = new Set(catalogSlugs)
  const out: AgentCliWrappedHandle[] = []

  for (const root of roots) {
    let entries: string[] = []
    try { entries = await fs.readdir(root) } catch { continue }
    for (const entry of entries) {
      if (!entry.startsWith("adapter-")) continue
      const slug = entry.slice("adapter-".length)
      if (seen.has(slug)) continue
      seen.add(slug)
      try {
        const resolved = await resolveAdapter(slug)
        out.push(wrapCliHandle(slug, resolved.handle, resolved.packageName ?? `@agentproto/adapter-${slug}`))
      } catch { /* not importable */ }
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * Enumerate adapters starting from a static catalog and enriching each entry
 * with its runtime availability status:
 *
 *   "supported" — known to agentproto, package not importable (not installed)
 *   "available" — package resolves; requiresSetup but no ledger yet
 *   "ready"     — package resolves + setup complete (or no setup needed)
 *
 * Also appends any adapters discovered in node_modules that aren't in the
 * catalog, so locally-installed custom adapters still appear.
 *
 * Status is derived via the kit's `computeStatus`: resolved × requiresSetup ×
 * ledger-exists — never via `handle.check()` (per OQ-5).
 */
export async function listAdaptersWithCatalog(
  catalog: readonly AdapterCatalogEntry[]
): Promise<(AdapterInfo & { status: "supported" | "available" | "ready"; hint?: string })[]> {
  const resolver = makeAdapterResolver<AgentCliWrappedHandle>({
    load: async (slug: string) => {
      const resolved = await resolveAdapter(slug)
      return wrapCliHandle(slug, resolved.handle, resolved.packageName ?? `@agentproto/adapter-${slug}`)
    },
  })

  const ledger = makeSetupLedger()

  const catalogSlugs = new Set(catalog.map((e) => e.slug))
  const lister = makeAdapterLister<AgentCliWrappedHandle, AgentCliInfo>({
    catalog,
    resolver,
    ledger,
    toInfo: toAgentCliInfo,
    discoverExtras: () => discoverExtraHandles(catalogSlugs),
  })

  const entries = await lister()
  return entries.map((e) => ({
    slug: e.slug,
    name: e.name,
    version: e.version,
    description: e.description,
    protocol: e.info?.protocol ?? "unknown",
    streaming: e.info?.streaming ?? false,
    packageName: e.packageName,
    commands: e.info?.commands ?? [],
    models: e.info?.models ?? [],
    status: e.status,
    ...(e.hint !== undefined ? { hint: e.hint } : {}),
  }))
}
