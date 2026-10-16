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
 * `<workspace>/.agents/<id>/AGENT.md` (the canonical hand-written layout);
 * `agentPath` is an explicit AGENT.md path (`agentId` wins when both given).
 *
 * Caller-supplied fields always win: the manifest only fills a slot the
 * caller left unspecified.
 */

import { isAbsolute, join, resolve as resolvePath } from "node:path"
import { loadAgent } from "@agentproto/agent"
import type { AgentAdapterResolver } from "./http-server.js"
import { projectAgentToSpawn, type AgentProjectionCaps } from "./agent-projection.js"

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
    return { ok: true, path: join(root, ".agents", ref.agentId.trim(), "AGENT.md") }
  }
  return { ok: false, code: "no_agent_ref", message: "agent_start: no agentId/agentPath given." }
}

export interface AgentManifestSpawnDefaults {
  readonly path: string
  readonly model?: string
  /** Composed text for a no-channel adapter (first-prompt prefix). */
  readonly instructions?: string
  /** Composed text for an adapter with a real system-prompt channel. */
  readonly systemPrompt?: string
  readonly skills?: string[]
  /** Gateway allowlist (`?allowTools=`). */
  readonly tools?: string[]
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
      ...(projected.model !== undefined ? { model: projected.model } : {}),
      ...(projected.instructions !== undefined ? { instructions: projected.instructions } : {}),
      ...(projected.systemPrompt !== undefined ? { systemPrompt: projected.systemPrompt } : {}),
      ...(projected.skills !== undefined ? { skills: projected.skills } : {}),
      ...(projected.tools !== undefined ? { tools: projected.tools } : {}),
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
