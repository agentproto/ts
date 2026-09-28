/**
 * `session_capabilities` MCP tool / `GET /sessions/:id/capabilities` HTTP
 * route — one read that tells a UI everything a session can do and has
 * attached: harness slash commands, modes/posture, model/effort, MCP
 * servers, skills, permission hold. Today these are scattered (some only in
 * the agent-tools `full: true` descriptor projection, skills not stored at
 * all) — this module is the single place both surfaces build their
 * (identical) JSON body from, so they can never drift apart.
 *
 * The shape below is a FROZEN contract (see
 * `.plans/session-chat-harness-surfaces/PLAN-A-daemon-capabilities.md`): a
 * parallel session-chat UI build codes against these exact field names.
 */

import type { SessionDescriptor } from "./sessions.js"
import { CANONICAL_POSTURES } from "./canonical-posture.js"
import type { CanonicalPosture } from "./session-config.js"
import { conversationTerminalSlugFor } from "./conversation-store.js"

export type SessionArm = "acp" | "print" | "pty" | "other"

export interface SessionCapabilityCommand {
  name: string
  description?: string
  hint?: string
}

export interface SessionCapabilityMode {
  id: string
  name: string
  description?: string
}

export interface SessionCapabilityMcpServer {
  name: string
  transport: string
  ref?: string
}

export interface SessionCapabilities {
  sessionId: string
  adapter: string
  arm: SessionArm
  model?: string
  effort?: string
  posture?: SessionDescriptor["posture"]
  availableModes: SessionCapabilityMode[]
  currentModeId?: string
  canonicalPostures: readonly CanonicalPosture[]
  commands: SessionCapabilityCommand[]
  commandsSupported: boolean
  mcpServers: SessionCapabilityMcpServer[]
  skills: string[]
  skillsApplied: boolean
  permissionHold: boolean
  pendingPermissions: number
}

/**
 * Adapters whose AIP-45 manifest declares a `skills` spawn option — see
 * `normalizeSkillsOption` in spawn-defaults.ts. Every other adapter
 * (claude-code, which auto-discovers skills from `~/.claude/skills`) still
 * gets `SessionDescriptor.skills` recorded for display, but never reads it
 * back. A fixed allowlist rather than a live manifest lookup: this module is
 * shared by the MCP tool and the HTTP route, neither of which has an adapter
 * catalog wired in every deployment.
 */
const SKILLS_APPLYING_ADAPTERS = new Set(["hermes"])

/**
 * Classify a session's live protocol arm — the same distinction the ACP vs
 * print vs proprietary protocol arms make inside `@agentproto/driver-agent-cli`,
 * surfaced here from the one signal the runtime already tracks:
 * `desc.capabilities.commandsSupported` (stamped by `stampCapabilities` in
 * sessions.ts from `AgentSessionLike.steer` presence — only the ACP arm ever
 * wires that method on). `"pty"` for a raw terminal, `"other"` for anything
 * else (command/browser one-shots). Never derived from whether
 * `availableCommands`/`availableModes` currently hold anything — a live ACP
 * session that hasn't reported either yet is still `"acp"`.
 */
export function sessionArm(desc: Pick<SessionDescriptor, "kind" | "capabilities">): SessionArm {
  if (desc.kind === "terminal") return "pty"
  if (desc.kind === "agent-cli") {
    return desc.capabilities?.commandsSupported === true ? "acp" : "print"
  }
  return "other"
}

/**
 * Build the `SessionCapabilities` body for one session. Never throws for a
 * well-formed descriptor — an unknown/out-of-scope session is the caller's
 * job to reject before this is called (same lookup + subtree-scoping
 * convention as `session_context_status`).
 */
export function buildSessionCapabilities(
  desc: SessionDescriptor,
  pendingPermissions: number,
): SessionCapabilities {
  return {
    sessionId: desc.id,
    adapter: desc.adapterSlug ?? conversationTerminalSlugFor(desc) ?? "unknown",
    arm: sessionArm(desc),
    ...(desc.model ? { model: desc.model } : {}),
    ...(desc.effort ? { effort: desc.effort } : {}),
    ...(desc.posture !== undefined ? { posture: desc.posture } : {}),
    availableModes: (desc.availableModes ?? []).map(m => ({
      id: m.id,
      name: m.name,
      ...(m.description ? { description: m.description } : {}),
    })),
    canonicalPostures: CANONICAL_POSTURES,
    commands: (desc.availableCommands ?? []).map(c => ({
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      ...(c.input?.hint ? { hint: c.input.hint } : {}),
    })),
    commandsSupported: desc.capabilities?.commandsSupported === true,
    mcpServers: (desc.mcpServers ?? []).map(s => ({
      name: s.name,
      transport: s.transport,
      ...(s.ref ? { ref: s.ref } : {}),
    })),
    skills: desc.skills ?? [],
    skillsApplied: desc.adapterSlug !== undefined && SKILLS_APPLYING_ADAPTERS.has(desc.adapterSlug),
    permissionHold: desc.permissionHold === true,
    pendingPermissions,
  }
}
