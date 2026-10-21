/**
 * Resolve a spawn's optional AIP-42 manifest reference (`agentId` /
 * `agentPath`) into the ordinary spawn defaults `spawnAgentSession` already
 * understands — the model, the composed instructions (body + persona +
 * boundaries + traits), the declared skills, and the gateway tool scope.
 *
 * This is the manifest-by-ID/PATH twin of `app_run`'s per-agent projection
 * (`app-tools.ts`'s `loadAgentPromptDefaults` + `projectAgentToSpawn`): the
 * SAME `projectAgentToSpawn` (`agent-projection.ts`) renders the manifest, so
 * a session spawned with `agentId: "reviewer"` behaves exactly like one
 * spawned by `app_run` for a bundled `reviewer` agent. `agentId` resolves to
 * `<workspace>/.agents/<id>/AGENT.md` (the canonical hand-written layout; an
 * `@owner/` prefix is stripped for the directory, matching
 * `renderAgentManifest`); `agentPath` is an explicit AGENT.md path. When BOTH
 * are given, `agentPath` wins.
 *
 * Caller-supplied fields always win: the manifest only fills a slot the
 * caller left unspecified.
 */

import { isAbsolute, join, resolve as resolvePath } from "node:path"
import { loadAgent } from "@agentproto/agent"
import { stripOwner } from "@agentproto/app-kit"
import type { AgentAdapterResolver } from "./http-server.js"
import { projectAgentToSpawn, type AgentProjectionCaps } from "./agent-projection.js"
import { parseAgentClerkHook, type ClerkHookConfig } from "./clerk-hook-config.js"

export interface AgentManifestRef {
  /** Logical agent id, resolved under `<root>/.agents/<id>/AGENT.md`. */
  readonly agentId?: string
  /** Explicit AGENT.md path (absolute, or relative to `root`). Wins over `agentId`. */
  readonly agentPath?: string
}

export interface ResolvedAgentManifestPath {
  readonly ok: true
  readonly path: string
}

export interface AgentManifestRefError {
  readonly ok: false
  readonly code: "no_agent_ref" | "agent_manifest_unresolved" | "agent_manifest_unreadable"
  readonly message: string
}

/**
 * Resolve an `agentId`/`agentPath` pair to an absolute AGENT.md path. Pure —
 * no filesystem access. `root` is the session's resolved workspace/cwd; an
 * `agentId` needs it (an explicit `agentPath` does not).
 */
export function resolveAgentManifestPath(
  ref: AgentManifestRef,
  root: string | undefined,
): ResolvedAgentManifestPath | AgentManifestRefError {
  if (ref.agentPath !== undefined && ref.agentPath.trim() !== "") {
    const p = ref.agentPath.trim()
    return { ok: true, path: isAbsolute(p) ? p : resolvePath(root ?? process.cwd(), p) }
  }
  if (ref.agentId !== undefined && ref.agentId.trim() !== "") {
    if (root === undefined) {
      return {
        ok: false,
        code: "agent_manifest_unresolved",
        message:
          `agent_start: agentId "${ref.agentId}" needs a workspace/cwd to resolve ` +
          "`<workspace>/.agents/<id>/AGENT.md` — pass `cwd` (or `workspaceSlug`).",
      }
    }
    return {
      ok: true,
      path: join(root, ".agents", stripOwner(ref.agentId.trim()), "AGENT.md"),
    }
  }
  return { ok: false, code: "no_agent_ref", message: "agent_start: no agentId/agentPath given." }
}

export interface AgentManifestSpawnDefaults {
  readonly path: string
  /** The manifest's own `id:` (may carry an `@owner/` prefix). Recorded on
   *  the spawned session so the gateway can bind a per-caller grant check
   *  (e.g. `create_tool`) to the caller's OWN manifest instead of trusting a
   *  caller-supplied tool argument. */
  readonly id: string
  readonly model?: string
  /** Adapter options the manifest projected — the AGENT.md path for a
   *  manifest-native adapter (`caps.agentManifestOption`, e.g. mastra-agent).
   *  Undefined for every other adapter. */
  readonly options?: Record<string, string>
  /** Composed text for a no-channel adapter (first-prompt prefix). */
  readonly instructions?: string
  /** Composed text for an adapter with a real system-prompt channel. */
  readonly systemPrompt?: string
  readonly skills?: string[]
  /** Gateway allowlist (`?allowTools=`). */
  readonly tools?: string[]
  /** The manifest's AGENT level of the AIP-68 clerk hook, read from the
   *  manifest's `metadata.hooks.clerk`. Undefined when the manifest states
   *  none - the less specific levels (workspace, daemon) then apply. */
  readonly hooks?: { clerk?: Partial<ClerkHookConfig> }
  readonly warnings: string[]
}

export interface AgentManifestDefaultsResult {
  readonly ok: true
  readonly defaults: AgentManifestSpawnDefaults
}

/**
 * Load the manifest at `path` and project it onto spawn fields through
 * `projectAgentToSpawn`, using the resolved adapter's capability flags
 * (manifest-native option, system-prompt channel, skill delivery). An
 * unreadable/invalid manifest is a clear, typed error — never a silent
 * fall-through to an unconfigured spawn.
 */
export async function loadAgentManifestDefaults(
  path: string,
  opts: { adapter: string; resolveAgentAdapter?: AgentAdapterResolver; modelOverride?: string },
): Promise<AgentManifestDefaultsResult | AgentManifestRefError> {
  let loaded: Awaited<ReturnType<typeof loadAgent>>
  try {
    loaded = await loadAgent(path)
  } catch (err) {
    return {
      ok: false,
      code: "agent_manifest_unreadable",
      message: `agent_start: could not load AGENT.md "${path}": ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const caps = await projectionCapsFor(opts.resolveAgentAdapter, opts.adapter)
  // The AGENT level of the clerk hook, when the manifest carries one
  // (`metadata.hooks.clerk`).
  const manifestHooks = manifestClerkHook(loaded.handle.metadata)
  const model = typeof loaded.handle.model === "string" ? loaded.handle.model : undefined
  const projected = projectAgentToSpawn(
    { path, handle: loaded.handle, body: loaded.body, ...(model !== undefined ? { model } : {}) },
    caps,
    opts.modelOverride,
  )
  return {
    ok: true,
    defaults: {
      path,
      id: loaded.handle.id,
      ...(projected.model !== undefined ? { model: projected.model } : {}),
      ...(projected.options !== undefined ? { options: projected.options } : {}),
      ...(projected.instructions !== undefined ? { instructions: projected.instructions } : {}),
      ...(projected.systemPrompt !== undefined ? { systemPrompt: projected.systemPrompt } : {}),
      ...(projected.skills !== undefined ? { skills: projected.skills } : {}),
      ...(projected.tools !== undefined ? { tools: projected.tools } : {}),
      ...(manifestHooks !== undefined ? { hooks: manifestHooks } : {}),
      warnings: projected.warnings,
    },
  }
}

/** The resolver facts `projectAgentToSpawn` needs for one adapter slug —
 *  mirrors `app-tools.ts`'s `projectionCapsFor`. An unresolvable adapter
 *  projects as a plain harness (the spawn fails later with
 *  `adapter_not_found` on its own). */
async function projectionCapsFor(
  resolveAgentAdapter: AgentAdapterResolver | undefined,
  slug: string,
): Promise<AgentProjectionCaps> {
  const resolved = resolveAgentAdapter ? await resolveAgentAdapter(slug) : null
  if (!resolved) return {}
  return {
    ...(resolved.agentManifestOption !== undefined ? { agentManifestOption: resolved.agentManifestOption } : {}),
    ...(resolved.deliversSessionSkills ? { deliversSessionSkills: true } : {}),
    ...(resolved.supportsSystemPrompt ? { supportsSystemPrompt: true } : {}),
    ...(resolved.systemPromptMaxChars !== undefined ? { systemPromptMaxChars: resolved.systemPromptMaxChars } : {}),
    ...(resolved.declaredOptions !== undefined ? { declaredOptions: resolved.declaredOptions } : {}),
  }
}

/**
 * Read the AGENT level of the AIP-68 clerk hook out of a manifest's
 * `metadata` (`metadata.hooks.clerk`). Undefined when the manifest states
 * none - the manifest's `metadata` is the namespaced home for
 * daemon-specific settings (the AIP-42 frontmatter has no free-form
 * top-level key).
 */
function manifestClerkHook(metadata: unknown): { clerk?: Partial<ClerkHookConfig> } | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const hooks = (metadata as Record<string, unknown>).hooks
  if (!hooks || typeof hooks !== "object") return undefined
  const clerk = parseAgentClerkHook({ hooks: hooks as Record<string, unknown> })
  return Object.keys(clerk).length > 0 ? { clerk } : undefined
}
