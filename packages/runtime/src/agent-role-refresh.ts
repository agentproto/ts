/**
 * AIP-42 hot role refresh — the generic version of Pygmalion's private
 * "composed-prompt-hash" mechanism.
 *
 * AIP-42 agents are rendered ONCE at spawn (`load-agent.ts` is only ever
 * called by `spawn-agent-manifest.ts`'s `loadAgentManifestDefaults`, itself
 * only called from `session-spawn.ts`): editing a live keepAlive session's
 * AGENT.md has no effect on it whatsoever until it restarts. This module
 * gives any such session a way to notice an edit and react to it WITHOUT a
 * restart, for the part that can change in place — the rendered role text —
 * while being honest about the part that can't: `tools` (AIP-14 refs) scope
 * stdio MCP servers that are fixed at spawn, so a tools change can only ever
 * take effect through an actual restart.
 *
 * `fingerprintAgentRole` is the hashing half: deliberately excludes the
 * model (a model change rides `session_restart`'s own `model` override, not
 * this path) and hashes the role text and the sorted tool-id list
 * SEPARATELY, so a caller can tell "the words changed" apart from "the
 * capability ask changed" — the same distinction Pygmalion's private
 * mechanism drew by hand. `computeAgentRoleRefresh` is the diff half: reload
 * the manifest, re-render, and compare against the fingerprint the session
 * was spawned (or last refreshed) with.
 *
 * Pure except for the one file read `loadAgentManifestDefaults` does — no
 * registry, no sendMessage, no session mutation. `sessions.ts`'s
 * `refreshAgentRole` is the impure half that decides what to DO with the
 * diff (push a steer message, flag a restart).
 */

import { createHash } from "node:crypto"
import {
  loadAgentManifestDefaults,
  type AgentManifestSpawnDefaults,
  type AgentManifestRefError,
} from "./spawn-agent-manifest.js"
import type { AgentAdapterResolver } from "./http-server.js"

export interface AgentRoleFingerprint {
  /** Hash of the rendered role text (`systemPrompt` ?? `instructions` ?? ""). */
  roleHash: string
  /** Hash of the sorted, comma-joined declared tool ids. */
  toolsHash: string
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)
}

/**
 * Fingerprint the two parts of a manifest projection that a hot refresh
 * cares about. The MODEL is deliberately excluded — see this module's
 * top-of-file comment.
 */
export function fingerprintAgentRole(
  defaults: Pick<AgentManifestSpawnDefaults, "instructions" | "systemPrompt" | "tools">,
): AgentRoleFingerprint {
  const roleText = defaults.systemPrompt ?? defaults.instructions ?? ""
  const toolsText = [...(defaults.tools ?? [])].sort().join(",")
  return { roleHash: hashText(roleText), toolsHash: hashText(toolsText) }
}

export interface AgentRoleRefreshInput {
  /** Absolute AGENT.md path — `SessionDescriptor.meta.agentManifestPath`. */
  agentManifestPath: string
  /** The session's adapter slug, so the re-render uses the same projection
   *  (system-prompt channel vs. prefix) the original spawn did. */
  adapter: string
  /** The session's CURRENT model — re-rendering never changes it; only
   *  fixes the fingerprint to the model the role was last rendered for. */
  model?: string
  /** The session's previously recorded fingerprint, if any. Absent (a
   *  session spawned before this field existed) ⇒ this call establishes a
   *  baseline and reports no change, rather than guessing. */
  previousRoleHash?: string
  previousToolsHash?: string
  resolveAgentAdapter?: AgentAdapterResolver
}

export interface AgentRoleRefreshOk {
  ok: true
  /** The rendered role text changed since the last recorded fingerprint. */
  roleChanged: boolean
  /** The declared tool list changed since the last recorded fingerprint —
   *  reported, never acted on: stdio MCP servers are fixed at spawn, so
   *  this can only take effect through a restart. */
  toolsChanged: boolean
  roleHash: string
  toolsHash: string
  /** The freshly rendered role text — present only when `roleChanged`, so a
   *  caller that doesn't need it never pays for it in the common no-op case. */
  roleText?: string
  warnings: string[]
}

export type AgentRoleRefreshResult = AgentRoleRefreshOk | AgentManifestRefError

/**
 * Reload `input.agentManifestPath`, re-render it through the same
 * projection the original spawn used, and diff the result against the
 * recorded fingerprint. Never mutates anything and never pushes a message —
 * `sessions.ts`'s `refreshAgentRole` does both of those, using this result.
 */
export async function computeAgentRoleRefresh(
  input: AgentRoleRefreshInput,
): Promise<AgentRoleRefreshResult> {
  const manifest = await loadAgentManifestDefaults(input.agentManifestPath, {
    adapter: input.adapter,
    ...(input.resolveAgentAdapter ? { resolveAgentAdapter: input.resolveAgentAdapter } : {}),
    ...(input.model !== undefined ? { modelOverride: input.model } : {}),
  })
  if (!manifest.ok) return manifest

  const fp = fingerprintAgentRole(manifest.defaults)
  const roleChanged =
    input.previousRoleHash !== undefined && fp.roleHash !== input.previousRoleHash
  const toolsChanged =
    input.previousToolsHash !== undefined && fp.toolsHash !== input.previousToolsHash

  return {
    ok: true,
    roleChanged,
    toolsChanged,
    roleHash: fp.roleHash,
    toolsHash: fp.toolsHash,
    ...(roleChanged
      ? { roleText: manifest.defaults.systemPrompt ?? manifest.defaults.instructions ?? "" }
      : {}),
    warnings: manifest.defaults.warnings,
  }
}

/** The steer text pushed into a live session when its role changed. Exported
 *  so `sessions.ts` and tests render the exact same wording. */
export function renderRoleUpdateNotice(roleText: string): string {
  return (
    "Your operating role (AGENT.md) was updated by the operator while this " +
    "session was running. Adopt the text below as your role / system " +
    "instructions from this point forward, replacing whatever you were " +
    "given at the start of this session. Do not reply to the user about " +
    "this notice — it is not a request, just continue operating under the " +
    "updated role on your next action.\n\n" +
    "--- Updated role ---\n" +
    roleText
  )
}
