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
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import type {
  AgentCliHandle,
  AgentCliMode,
  AgentCliRouteSelection,
} from "@agentproto/driver-agent-cli"
import {
  makeAdapterResolver,
  makeAdapterLister,
  makeSetupLedger,
  collectAgentprotoNamespaceRoots,
  discoverCapabilities,
  type AdapterHandle,
  type AdapterCatalogEntry,
  type CapabilityStrategy,
  type HarnessCapabilities,
  type DiscoverCtx,
} from "@agentproto/provider-kit"
import { isAgentCliAuthConfigured, type AdapterAuthDescriptor } from "@agentproto/runtime"
import { CatalogProviderSchema, type CatalogProvider } from "@agentproto/model-catalog"
import {
  acpHandleFromSpec,
  resolveAcpSpec,
  listAcpGenericAdapters,
} from "./acp-generic.js"

/** Slash-command declared in an adapter manifest (AIP-45 `commands[]`). */
export interface AgentCliCommand {
  name: string
  description?: string
}

export interface ResolvedAdapter {
  readonly slug: string
  readonly handle: AgentCliHandle
  readonly source: "npm" | "file" | "bundled" | "acp-config" | "acp-catalog"
  readonly packageName?: string
  /** True when this resolution was served from the last-known-good cache
   *  because the current import attempt failed (see `importFresh`'s doc
   *  comment for why that happens mid-rebuild). Never present on an
   *  actually-fresh successful resolution — callers that only care about
   *  spawning don't need to check it, callers that surface status
   *  (`listAdaptersWithCatalog`) must not report it as plain "ready". */
  readonly stale?: true
  /** The adapter's optional `<camelSlug>Capabilities` export (harness
   *  capability-discovery layer) — present when the adapter's module
   *  exports one, absent otherwise (falls back to
   *  `deriveDeclaredCapabilities` at the call site). */
  readonly capabilitiesStrategy?: CapabilityStrategy
}

/** Mode metadata surfaced in `adapter_list` — the UI-safe subset of an
 *  AIP-45 `modes[]` entry. Omits the spawn internals (`bin_args_*`, `env`)
 *  since those aren't information a picker needs; carries the honest
 *  `status`/`status_note` so a declared-but-no-op mode is visible. */
export interface AdapterMode {
  id: string
  description?: string
  /** Absent in the manifest ⇒ normalised to "active" here. */
  status: NonNullable<AgentCliMode["status"]>
  status_note?: string
}

/**
 * Compact metadata about an installed adapter — the shape returned
 * by `listInstalledAdapters()` and exposed via the daemon's
 * `GET /adapters` route + `adapter_list` MCP tool. Only fields
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
   *  to avoid trial-and-error validation errors. Flat id list — kept
   *  exactly as before so every existing consumer of this field keeps
   *  working untouched; see `modelDetails` for the provider/mode a
   *  structured entry additionally states. */
  models: string[]
  /** AIP-45 `modes[]` the adapter declares, projected to the UI-safe
   *  subset (id + description + honest status). Empty when the adapter
   *  declares no modes. `status` defaults to "active" when the manifest
   *  omits it, so a declared mode is never silently statusless. */
  modes: AdapterMode[]
  /** Same models as `models`, in the same order, each carrying the
   *  `provider`/`mode` a structured `models.allowed` entry states.
   *  `provider`/`mode` are undefined for a bare-string entry — an
   *  unstated provider is never guessed here (see AdapterModelInfo). */
  modelDetails: AdapterModelInfo[]
  /**
   * How this adapter selects a model (AIP-45 `models.apply`, defaulted the
   * same way the driver does — omitted manifest field ⇒ `"config"`). Tells
   * a client whether a mid-session model switch (`POST /sessions/:id/
   * model`) can even work for this adapter: `"arg"` bakes the model into
   * spawn-time argv, so EVERY switch attempt reports `requires-restart`
   * regardless of target model — a picker should mark every row that way
   * rather than let the user discover it per-pick. Absent for the ACP
   * generic-config adapter family (`listAcpGenericAdapters`), which has no
   * `models.apply` concept of its own; treat an absent value as `"config"`,
   * the same default the manifest schema applies.
   */
  modelApply?: "config" | "command" | "arg"
  /**
   * How this adapter's spawn ROUTE relates to the chosen model (AIP-45
   * launch-menu drill-down, WP1) — projected verbatim from the manifest's
   * `routeSelection`. A capability-derived spawn/config drill-down reads
   * this to decide whether the connection step is a real choice (`"free"`)
   * or a read-only badge (`"derived-from-model"`, the route falls out of the
   * model id's vendor prefix). Undefined ⇒ `"free"` (back-compat: an adapter
   * that never declared the axis keeps presenting a route choice). Distinct
   * from the auth-derivation axis (`modelDerivedApiKey`).
   */
  routeSelection?: AgentCliRouteSelection
}

/** One entry of an adapter's declared model menu, projected from a
 *  `models.allowed` item — bare string or {@link AgentCliModelEntry}.
 *  `provider`/`mode` stay undefined for a bare-string entry: an unstated
 *  provider must never be guessed downstream (a wrong-but-confident
 *  guess would bill the wrong account). See AGENTS.md / AIP-45 for the
 *  three-facts-in-one-string problem this splits apart. */
export interface AdapterModelInfo {
  id: string
  /** Who serves/bills this model (a ProviderPreset id, or a direct
   *  provider like "anthropic"). Undefined when unstated. */
  provider?: string
  /** This adapter's mode id that routes to `provider`. Undefined when
   *  the adapter routes on its own or needs no mode switch. */
  mode?: string
}

/** Narrows an `unknown` array element to the shape a structured
 *  `models.allowed` object entry must have — `id` present and a string.
 *  The one unavoidable cast in this module: reading a property off
 *  `unknown` to validate it requires it, same as every other loosely-typed
 *  handle-field check in this file (e.g. `handle.commands as
 *  AgentCliCommand[]` below). Nothing past this guard is unchecked. */
function hasStringId(value: unknown): value is { id: string; provider?: unknown; mode?: unknown } {
  if (typeof value !== "object" || value === null) return false
  return typeof (value as { id?: unknown }).id === "string"
}

/** Normalise a raw `models.allowed` field (bare strings and/or
 *  `{id, provider?, mode?}` objects — see AgentCliModelEntry) to
 *  `AdapterModelInfo[]`. Anything not a string and not an object with a
 *  string `id` is dropped rather than guessed at. Accepts `unknown`
 *  because callers pull this off a loosely-typed handle field. */
function toModelDetails(allowed: unknown): AdapterModelInfo[] {
  if (!Array.isArray(allowed)) return []
  const out: AdapterModelInfo[] = []
  for (const entry of allowed) {
    if (typeof entry === "string") {
      out.push({ id: entry })
    } else if (hasStringId(entry)) {
      out.push({
        id: entry.id,
        ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}),
        ...(typeof entry.mode === "string" ? { mode: entry.mode } : {}),
      })
    }
  }
  return out
}

/** Read `models.apply` off a loosely-typed handle field, defaulted the
 *  same way `defineAgentCli`'s driver does when the manifest omits it —
 *  see `AdapterInfo.modelApply`'s doc for why this matters to a client. */
function toModelApply(models: unknown): "config" | "command" | "arg" {
  const apply = (models as { apply?: unknown } | undefined)?.apply
  return apply === "command" || apply === "arg" ? apply : "config"
}

/** Read a manifest's `routeSelection` off a loosely-typed handle field,
 *  narrowing to the known union (an unrecognised value ⇒ undefined, which
 *  a consumer treats as the `"free"` default — never guessed to a route
 *  choice that isn't there). */
function toRouteSelection(value: unknown): AgentCliRouteSelection | undefined {
  return value === "free" || value === "derived-from-model" ? value : undefined
}

const slugToCamel = (slug: string): string =>
  slug.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())

/** Project a manifest's `modes[]` to the UI-safe `AdapterMode[]`,
 *  normalising an absent `status` to "active". Accepts the loosely-typed
 *  handle field (a handle is `Readonly<AgentCliDefinition>` whose `modes`
 *  is `AgentCliMode[] | undefined`); anything not an array yields []. */
function toAdapterModes(modes: AgentCliMode[] | undefined): AdapterMode[] {
  if (!Array.isArray(modes)) return []
  return modes.map((m) => ({
    id: m.id,
    ...(m.description !== undefined ? { description: m.description } : {}),
    status: m.status ?? "active",
    ...(m.status_note !== undefined ? { status_note: m.status_note } : {}),
  }))
}

// Scoped to this module's own location — used only to RESOLVE a
// specifier to an absolute path (never to `require()` anything), so its
// CJS-vs-ESM provenance doesn't matter.
const resolveFromHere = createRequire(import.meta.url)

/**
 * `protocol: "proprietary"` handles carry an `adapter` field naming an npm
 * package that `createProprietaryProtocolArm` (inside
 * `@agentproto/driver-agent-cli`) dynamic-`import()`s a SECOND time, at
 * session-start, to obtain the `createAgentCliClient` factory. That second
 * import runs from a module that deliberately does NOT depend on any
 * specific adapter package (driver-agent-cli is adapter-agnostic by
 * design) — so a bare specifier that resolves fine from HERE (this module
 * lists every known adapter as a devDependency, and just proved the
 * specifier resolves by successfully importing it above) can fail to
 * resolve there, because Node's ancestor `node_modules` walk for a bare
 * specifier starts from the IMPORTING module's own location, not this
 * one's. Rewrite `adapter` to the fully-resolved absolute path before
 * handing the handle off: dynamic `import()` of an absolute path always
 * succeeds regardless of which module performs it, so the second import
 * is no longer sensitive to where in the dependency graph it runs. This
 * applies uniformly to every `protocol: "proprietary"` handle — not just
 * this one — since any future proprietary adapter hits the exact same
 * two-context-resolution gap.
 */
function withResolvedProprietaryAdapter(
  candidate: AgentCliHandle,
  packageSpecifier: string
): AgentCliHandle {
  if (candidate.protocol !== "proprietary" || !candidate.adapter) return candidate
  return { ...candidate, adapter: resolveFromHere.resolve(packageSpecifier) }
}

/**
 * Thrown by `importFresh` when the specifier resolved to a real path on
 * disk (the npm package IS installed) but the subsequent `import()` of
 * that path still failed. Distinguishes "present but transiently broken"
 * from "not resolvable at all" — see the incident writeup at
 * `resolveAdapter`'s last-known-good fallback below. Empirically this is
 * a NARROW window (a reproducible probe against a real `tsup` rebuild
 * caught it in roughly 1 of 24 iterations): `tsup`'s `clean: true`
 * deletes `dist/*` before rewriting it, so for most of a rebuild's
 * duration the resolved path is genuinely ABSENT (plain `MODULE_NOT_FOUND`,
 * not this error) — indistinguishable from "never installed" by resolution
 * alone. This error only fires in the brief gap between the file being
 * (re)created and its content finishing being written.
 */
export class AdapterImportFailedError extends Error {
  constructor(message: string, readonly resolvedPath: string) {
    super(message)
    this.name = "AdapterImportFailedError"
  }
}

/**
 * Dynamic-`import()` a bare specifier without inheriting Node's process-
 * lifetime ESM module cache. In a long-running daemon, `resolveAdapter`
 * calls stack up over hours/days — a plain `import(packageName)` returns
 * the SAME module object forever, even after `tsup`/`tsup --watch` rewrites
 * an adapter's `dist/*.js` on disk (the "frozen catalog" problem: picking up
 * a rebuilt adapter used to require restarting the daemon).
 *
 * Fix: resolve the specifier to its actual file on disk first (works for
 * both an npm-installed package and a workspace-symlinked one — this is the
 * same CJS-resolve trick `withResolvedProprietaryAdapter` above already
 * relies on), then import that file's URL with a `?v=<mtime>` cache-buster.
 * An unchanged file (same mtime) hits the exact same cache entry every call
 * — no unbounded growth of the module registry — but a rebuild changes the
 * mtime, producing a new URL and thus a genuinely fresh import.
 *
 * That same re-import-every-request behavior is also why a build makes an
 * adapter briefly vanish: mid-rebuild, `dist/*.js` is momentarily deleted
 * or half-written, so the import genuinely throws. `resolveAdapter`'s
 * last-known-good fallback is what keeps that throw from being reported as
 * "not installed" — see there for the rest of the story.
 */
async function importFresh(specifier: string): Promise<Record<string, unknown>> {
  let resolvedPath: string
  try {
    resolvedPath = resolveFromHere.resolve(specifier)
  } catch {
    // Not resolvable to a file on disk from here (e.g. an export condition
    // the CJS resolver can't see) — fall back to a plain import; there's
    // no local file to bust a cache against.
    return (await import(specifier)) as Record<string, unknown>
  }
  let cacheBuster = ""
  try {
    cacheBuster = `?v=${(await fs.stat(resolvedPath)).mtimeMs}`
  } catch {
    /* stat failed — import without a cache-buster rather than fail resolution */
  }
  try {
    return (await import(pathToFileURL(resolvedPath).href + cacheBuster)) as Record<
      string,
      unknown
    >
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new AdapterImportFailedError(
      `resolved '${specifier}' to '${resolvedPath}' but the import failed: ${cause}`,
      resolvedPath
    )
  }
}

interface LastKnownGoodEntry {
  readonly resolved: ResolvedAdapter
  readonly resolvedAt: number
}

/**
 * Per-process memory of the last successful resolution for each slug.
 * Deliberately NOT persisted across restarts: a genuinely-uninstalled
 * adapter must eventually be reported as such, and "eventually" has to
 * include "the daemon restarted" — a fresh process has no history to trust,
 * which is exactly the behavior a never-resolved adapter needs. Persisting
 * this would let an uninstalled adapter keep reporting "ready" forever
 * across restarts, silently defeating the whole point of the status.
 */
const lastKnownGood = new Map<string, LastKnownGoodEntry>()

/**
 * How long a last-known-good resolution is trusted after its most recent
 * successful import. `tsup`'s `clean: true` deletes `dist/*` before
 * rewriting it (confirmed by reading `packages/tooling/tsup/base.js` and by
 * a live probe: see `AdapterImportFailedError`'s doc comment) — during that
 * window the resolved path is genuinely absent, not just unreadable, so
 * "does the path still exist" cannot bound this the way an earlier draft of
 * this fix assumed. A bounded TTL is the only sound fallback. 5 minutes is
 * a wide margin over what was actually measured in this repo: a full
 * `pnpm build` across every package and adapter took ~42s wall-clock
 * (cold, no turbo-cache hits) on ordinary dev hardware; a single adapter's
 * own rebuild is under 2s. The margin covers a slower machine or a cold
 * cache without leaving a truly-uninstalled adapter reporting "ready" for
 * an unreasonable stretch after removal.
 */
let lastKnownGoodTtlMs = 5 * 60 * 1000

/** Test-only: drop every last-known-good entry so tests start clean. */
export function _resetLastKnownGoodForTests(): void {
  lastKnownGood.clear()
}

/** Test-only: override the last-known-good TTL so expiry is testable
 *  without a real multi-minute wait. Returns a restore function. */
export function _setLastKnownGoodTtlMsForTests(ms: number): () => void {
  const prev = lastKnownGoodTtlMs
  lastKnownGoodTtlMs = ms
  return () => {
    lastKnownGoodTtlMs = prev
  }
}

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
    mod = await importFresh(packageName)
  } catch (primaryErr) {
    // Fallback: strip the last hyphen-segment and try the parent package,
    // looking for the full camelCase export there.
    // e.g. "claude-code-print" → "@agentproto/adapter-claude-code" + export "claudeCodePrint"
    const hyphen = slug.lastIndexOf("-")
    if (hyphen > 0) {
      const parentPkg = `@agentproto/adapter-${slug.slice(0, hyphen)}`
      try {
        const parentMod = await importFresh(parentPkg)
        const parentCandidate = parentMod[camel] as AgentCliHandle | undefined
        if (
          parentCandidate &&
          typeof parentCandidate === "object" &&
          "name" in parentCandidate
        ) {
          const parentCapabilitiesStrategy = parentMod[`${camel}Capabilities`] as
            | CapabilityStrategy
            | undefined
          const resolved: ResolvedAdapter = {
            slug,
            handle: withResolvedProprietaryAdapter(parentCandidate, parentPkg),
            source: "npm",
            packageName: parentPkg,
            ...(typeof parentCapabilitiesStrategy === "function"
              ? { capabilitiesStrategy: parentCapabilitiesStrategy }
              : {}),
          }
          lastKnownGood.set(slug, { resolved, resolvedAt: Date.now() })
          return resolved
        }
      } catch {
        /* parent also missing — fall through to original error */
      }
    }

    // npm (and the parent-package fallback) both missed. Before failing,
    // try the generic ACP paths — a user-defined `config.acpAgents` entry,
    // then the curated `ACP_CATALOG`. npm stays first so a real adapter
    // package always wins; these are the zero-code fallback for any CLI
    // that already speaks ACP.
    const generic = await resolveAcpSpec(slug)
    if (generic) {
      const resolved: ResolvedAdapter = {
        slug,
        handle: acpHandleFromSpec(generic.spec),
        source: generic.source,
      }
      lastKnownGood.set(slug, { resolved, resolvedAt: Date.now() })
      return resolved
    }

    // Every live resolution path missed. The daemon re-imports on every
    // call (see `importFresh`'s doc comment) precisely so a rebuilt
    // adapter is picked up without a restart — the unavoidable side effect
    // is that mid-rebuild, this import genuinely throws. An adapter this
    // process has already resolved successfully gets the benefit of the
    // doubt for `lastKnownGoodTtlMs`: prefer the last-known-good handle
    // over reporting an installed adapter as gone.
    const cached = lastKnownGood.get(slug)
    if (cached && Date.now() - cached.resolvedAt <= lastKnownGoodTtlMs) {
      return { ...cached.resolved, stale: true }
    }

    const cause = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
    if (primaryErr instanceof AdapterImportFailedError) {
      // The package IS present on disk (resolution to a path succeeded) —
      // only the import itself failed just now. Never seen resolve before
      // (no last-known-good above), so we can't call this "rebuilding" with
      // certainty, but we CAN say it's wrong to call it "not installed":
      // that advice sends the operator to reinstall something that's
      // already there.
      throw new Error(
        `agentproto: adapter '${packageName}' resolves on disk but could not be ` +
          `imported just now — is something rebuilding it (tsup / tsup --watch)? ` +
          `If a build is in progress, wait for it to finish and retry; this is not ` +
          `a sign the package needs reinstalling.\n  cause: ${cause}`
      )
    }
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

  const capabilitiesStrategy = mod[`${camel}Capabilities`] as CapabilityStrategy | undefined
  const resolved: ResolvedAdapter = {
    slug,
    handle: withResolvedProprietaryAdapter(candidate, resolvedPackageName),
    source: "npm",
    packageName: resolvedPackageName,
    ...(typeof capabilitiesStrategy === "function" ? { capabilitiesStrategy } : {}),
  }
  lastKnownGood.set(slug, { resolved, resolvedAt: Date.now() })
  return resolved
}

/**
 * Enumerate every `@agentproto/adapter-*` package reachable from the
 * current node module-resolution path. Used by the daemon's
 * `GET /adapters` route and `adapter_list` MCP tool so UIs (web
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
        const modelDetails = toModelDetails(modelsField)
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
          models: modelDetails.map((m) => m.id),
          modes: toAdapterModes(resolved.handle.modes),
          modelDetails,
          modelApply: toModelApply(handle.models),
          ...(toRouteSelection(handle.routeSelection)
            ? { routeSelection: toRouteSelection(handle.routeSelection) }
            : {}),
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
 * Build a `DiscoverCtx` over this host's real filesystem/env for a
 * `CapabilityStrategy` to read. `readFile` normalises "file doesn't exist"
 * (ENOENT) to `null` — the contract every strategy in this repo already
 * codes against — and re-throws any other error (permissions, I/O), which
 * `discoverCapabilities`'s outer catch turns into a warning + manifest
 * fallback rather than a hard failure.
 */
function makeHostDiscoverCtx(): DiscoverCtx {
  return {
    homeDir: homedir(),
    env: process.env,
    async readFile(path: string) {
      try {
        return await fs.readFile(path, "utf8")
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null
        throw err
      }
    },
    warn(msg: string) {
      console.warn(`[agentproto/cli] harness capability discovery: ${msg}`)
    },
  }
}

/**
 * Behind the `harness_capabilities` MCP tool / `@agentproto/runtime`'s
 * `AdapterCapabilitiesLister`: for each installed adapter (or just
 * `opts.adapter` when given), resolves it and runs `discoverCapabilities` —
 * the adapter's own `capabilitiesStrategy` when `resolveAdapter` found one
 * (an optional `<camelSlug>Capabilities` export), else the pure manifest
 * projection. One shared `DiscoverCtx` per call (this host's real fs/env),
 * built once so every adapter's strategy reads the same snapshot.
 */
export async function listHarnessCapabilities(opts?: {
  adapter?: string
  /** Override the search root — mirrors `listInstalledAdapters`. */
  searchRoot?: string
}): Promise<HarnessCapabilities[]> {
  const ctx = makeHostDiscoverCtx()

  if (opts?.adapter) {
    const resolved = await resolveAdapter(opts.adapter)
    return [await discoverCapabilities(resolved.handle, resolved.capabilitiesStrategy, ctx)]
  }

  const adapters = await listInstalledAdapters({ searchRoot: opts?.searchRoot })
  const out: HarnessCapabilities[] = []
  for (const info of adapters) {
    try {
      const resolved = await resolveAdapter(info.slug)
      out.push(await discoverCapabilities(resolved.handle, resolved.capabilitiesStrategy, ctx))
    } catch {
      // Resolution can race with listInstalledAdapters' own snapshot (e.g.
      // mid-rebuild) — skip rather than fail the whole listing for one adapter.
    }
  }
  return out
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
  readonly modes: AdapterMode[]
  readonly modelDetails: AdapterModelInfo[]
  readonly modelApply: "config" | "command" | "arg"
  readonly packageName: string
  readonly originalHandle: AgentCliHandle
  /** Mirrors `ResolvedAdapter.stale` — set when this handle came from the
   *  last-known-good cache rather than a resolution that just succeeded.
   *  `listAdaptersWithCatalog` reads this to keep a stale resolution from
   *  reporting status "ready". */
  readonly stale?: true
}

/** Extract the family descriptor from a wrapped handle (never includes secrets). */
type AgentCliInfo = Pick<
  AdapterInfo,
  "protocol" | "streaming" | "commands" | "models" | "modes" | "modelDetails" | "modelApply" | "routeSelection"
> & { stale?: true; authRequired?: boolean; provider?: string }

function toAgentCliInfo(h: AgentCliWrappedHandle): AgentCliInfo {
  return {
    protocol: h.protocol,
    streaming: h.streaming,
    commands: h.commands,
    models: h.models,
    modes: h.modes,
    modelDetails: h.modelDetails,
    modelApply: h.modelApply,
    ...(h.stale ? { stale: true } : {}),
    ...(h.authRequired ? { authRequired: true } : {}),
    ...(typeof h.originalHandle.provider === "string" ? { provider: h.originalHandle.provider } : {}),
    ...(toRouteSelection(h.originalHandle.routeSelection)
      ? { routeSelection: toRouteSelection(h.originalHandle.routeSelection) }
      : {}),
  }
}

/** Project a wrapped handle's manifest billing-auth fields into the runtime's
 *  `AdapterAuthDescriptor` — the same projection `serve.ts`'s adapter
 *  resolver does for a real spawn (`CatalogProviderSchema` narrows an
 *  unrecognized `provider` string to undefined rather than guessing). Kept
 *  local to this module rather than shared: it's a small field-by-field
 *  read, not the money-critical precedence logic (that lives entirely in
 *  `resolveAuthSpec`, reused as-is via `isAgentCliAuthConfigured`). */
export function toAuthDescriptor(handle: AgentCliHandle): AdapterAuthDescriptor {
  const providerParse = handle.provider
    ? CatalogProviderSchema.safeParse(handle.provider)
    : undefined
  // The adapter's OWN declared per-model billing provider
  // (`models.allowed[].provider`) — authoritative for a model-derived-api-key
  // adapter whose declared model otherwise falls through to the global catalog's
  // (possibly different) routing for the same id.
  const modelProviders: Record<string, CatalogProvider> = {}
  for (const entry of handle.models?.allowed ?? []) {
    if (typeof entry === "string" || !entry.provider) continue
    const parsed = CatalogProviderSchema.safeParse(entry.provider)
    if (parsed.success) modelProviders[entry.id] = parsed.data
  }
  return {
    ...(providerParse?.success ? { provider: providerParse.data } : {}),
    ...(handle.authEnforce ? { authEnforce: handle.authEnforce } : {}),
    ...(handle.authSubscription ? { authSubscription: handle.authSubscription } : {}),
    ...(handle.modelDerivedApiKey ? { modelDerivedApiKey: handle.modelDerivedApiKey } : {}),
    ...(handle.gatewayAuth ? { gatewayAuth: handle.gatewayAuth } : {}),
    ...(Object.keys(modelProviders).length > 0 ? { modelProviders } : {}),
  }
}

/** Wrap a resolved slug+handle into the kit's `AdapterHandle` shape. */
export function wrapCliHandle(
  slug: string,
  handle: AgentCliHandle,
  packageName: string,
  stale?: true
): AgentCliWrappedHandle {
  const h = handle as Record<string, unknown>
  const modelsField = (h.models as { allowed?: unknown } | undefined)?.allowed
  const modelDetails = toModelDetails(modelsField)
  return {
    slug,
    name: typeof h.name === "string" ? h.name : slug,
    version: typeof h.version === "string" ? h.version : "?",
    description: typeof h.description === "string" ? h.description : "",
    requiresSetup: Array.isArray(h.setup) && (h.setup as unknown[]).length > 0,
    // Independent of requiresSetup — claude-code declares no setup[] but
    // authEnforce:"always" hard-fails every spawn without a billing
    // credential (the bug this axis exists to report honestly).
    authRequired: h.authEnforce === "always",
    check: async () => false,
    protocol: typeof h.protocol === "string" ? h.protocol : "unknown",
    streaming: !!(h.capabilities as { streaming?: boolean })?.streaming,
    packageName,
    commands: Array.isArray(h.commands) ? (h.commands as AgentCliCommand[]) : [],
    models: modelDetails.map((m) => m.id),
    modes: toAdapterModes(handle.modes),
    modelDetails,
    modelApply: toModelApply(h.models),
    originalHandle: handle,
    ...(stale ? { stale: true as const } : {}),
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
        out.push(
          wrapCliHandle(
            slug,
            resolved.handle,
            resolved.packageName ?? `@agentproto/adapter-${slug}`,
            resolved.stale
          )
        )
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
 *   "available" — package resolves; requiresSetup but no ledger yet, OR
 *                 authRequired but no billing credential resolves
 *   "ready"     — package resolves + setup complete (or no setup needed) AND
 *                 (authRequired is false, or a credential DOES resolve)
 *
 * Also appends any adapters discovered in node_modules that aren't in the
 * catalog, so locally-installed custom adapters still appear.
 *
 * Status is derived via the kit's `computeStatus`: resolved × requiresSetup ×
 * ledger-exists × (authRequired × authConfigured) — never via `handle.check()`
 * (per OQ-5). The auth axis is independent of `requiresSetup`: claude-code
 * declares no `setup[]` at all (`requiresSetup` is always false for it) but
 * `authEnforce:"always"` hard-fails every spawn without a billing credential
 * — `authProbe` (wired to the runtime's `isAgentCliAuthConfigured`, which
 * mirrors `resolveAuthSpec`'s exact precedence including the explicit-gate
 * on the providers store, PR #321) is what makes that honest instead of the
 * old `!requiresSetup` short-circuit reporting "ready" on zero credentials.
 *
 * A fourth status, `"unresolvable"`, sits outside that kit-owned vocabulary:
 * when `resolveAdapter` falls back to its last-known-good cache (see there),
 * the kit sees a normally-resolved handle and would compute "ready" — which
 * would silently hide the fact that the CURRENT import attempt just failed.
 * `resolved.stale` (threaded through `wrapCliHandle` → `AgentCliInfo`) is
 * checked below and overrides whatever the kit computed, so a rebuilding
 * adapter reads as neither "ready" (a lie — a spawn against a half-written
 * dist would still fail) nor "supported" (equally wrong — it tells the
 * operator to reinstall something that's already there).
 */
export async function listAdaptersWithCatalog(
  catalog: readonly AdapterCatalogEntry[]
): Promise<
  (AdapterInfo & {
    status: "supported" | "available" | "ready" | "unresolvable"
    hint?: string
  })[]
> {
  const resolver = makeAdapterResolver<AgentCliWrappedHandle>({
    load: async (slug: string) => {
      const resolved = await resolveAdapter(slug)
      return wrapCliHandle(
        slug,
        resolved.handle,
        resolved.packageName ?? `@agentproto/adapter-${slug}`,
        resolved.stale
      )
    },
  })

  const ledger = makeSetupLedger()

  const catalogSlugs = new Set(catalog.map((e) => e.slug))
  const lister = makeAdapterLister<AgentCliWrappedHandle, AgentCliInfo>({
    catalog,
    resolver,
    ledger,
    toInfo: toAgentCliInfo,
    authProbe: (handle) =>
      isAgentCliAuthConfigured(
        handle.slug,
        toAuthDescriptor(handle.originalHandle),
        handle.originalHandle.models?.default,
      ),
    discoverExtras: () => discoverExtraHandles(catalogSlugs),
  })

  const entries = await lister()
  return entries.map((e) => {
    const stale = e.info?.stale === true
    // "available" on a handle whose authRequired is true can ONLY be caused
    // by a missing billing credential here: claude-code (the one adapter
    // that sets authRequired) declares no setup[] at all, so requiresSetup
    // is always false for it — the kit's computeStatus would otherwise force
    // "ready" for a false requiresSetup, meaning the auth-required check is
    // the only path left that can land it on "available". Give the operator
    // something runnable instead of a bare status.
    const authHint =
      !stale && e.status === "available" && e.info?.authRequired === true
        ? `no billing credential configured — run \`claude setup-token\` (subscription) or ` +
          `\`agentproto auth provider set ${e.info?.provider ?? "<provider>"} sk-…\` (api-key), ` +
          `then add {"defaults":{"adapters":{"${e.slug}":{"auth":{"mode":"api-key"}}}}} to ` +
          `~/.agentproto/config.json`
        : undefined
    return {
      slug: e.slug,
      name: e.name,
      version: e.version,
      description: e.description,
      protocol: e.info?.protocol ?? "unknown",
      streaming: e.info?.streaming ?? false,
      packageName: e.packageName,
      commands: e.info?.commands ?? [],
      models: e.info?.models ?? [],
      modes: e.info?.modes ?? [],
      modelDetails: e.info?.modelDetails ?? [],
      modelApply: e.info?.modelApply ?? "config",
      ...(e.info?.routeSelection ? { routeSelection: e.info.routeSelection } : {}),
      status: stale ? ("unresolvable" as const) : e.status,
      ...(stale
        ? {
            hint:
              "resolved successfully before, but the last import attempt just failed — " +
              "likely mid-rebuild. Not reinstallable advice: the package is present.",
          }
        : authHint !== undefined
          ? { hint: authHint }
          : e.hint !== undefined
            ? { hint: e.hint }
            : {}),
    }
  })
}

/** A single row of the merged adapter listing — npm/native catalog
 *  entries and generic ACP entries share this shape (the latter also
 *  carry a `source`). */
export type AdapterListing = AdapterInfo & {
  status: "supported" | "available" | "ready" | "unresolvable"
  hint?: string
  source?: "acp-config" | "acp-catalog"
}

/**
 * The full adapter listing surfaced by `adapter_list` / `GET /adapters`:
 * every npm/native catalog adapter PLUS the generic ACP agents (curated
 * `ACP_CATALOG` + user `config.acpAgents`). Generic entries whose slug is
 * already covered by a native adapter are dropped, so a slug never appears
 * twice. Native adapters keep their richer status (`ready` after setup);
 * generic entries are `available` (bin on PATH) or `supported` (not yet).
 */
export async function listAdaptersWithAcp(
  catalog: readonly AdapterCatalogEntry[]
): Promise<AdapterListing[]> {
  const native = await listAdaptersWithCatalog(catalog)
  const nativeSlugs = new Set(native.map((e) => e.slug))
  const generic = await listAcpGenericAdapters({ excludeSlugs: nativeSlugs })
  return [...native, ...generic]
}
