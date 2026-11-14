import { join } from "node:path"
import { existsSync } from "node:fs"
import { stripOwner } from "@agentproto/app"

export const ROLE_ALIAS_DEPRECATION =
  'agent_start: "role" is a deprecated alias of "agent" (pass agent: "<name>"); it behaves the same and will be removed in @agentproto/runtime 6.0.0.'

export interface AgentRefInput {
  agent?: string
  agentId?: string
  agentPath?: string
  role?: string
}

export type AgentRefResult =
  | { ok: true; agentId?: string; agentPath?: string; role?: string }
  | { ok: false; code: "invalid_agent"; message: string }

export function resolveAgentRef(
  input: AgentRefInput,
  ctx: { cwd: string | undefined; roleNames: readonly string[]; manifestExists?: (path: string) => boolean },
): AgentRefResult {
  const agent = input.agent
  if (agent === undefined) {
    return {
      ok: true,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.agentPath !== undefined ? { agentPath: input.agentPath } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
    }
  }
  if (input.agentId !== undefined || input.agentPath !== undefined) {
    return {
      ok: false,
      code: "invalid_agent",
      message: 'agent_start: "agent" replaces "agentId" and "agentPath"; pass only one of them.',
    }
  }
  const ownerPrefixedId = /^@[^/]+\/[^/]+$/.test(agent)
  if (agent.endsWith(".md") || agent.includes("\\") || (agent.includes("/") && !ownerPrefixedId)) {
    return {
      ok: true,
      agentPath: agent,
      ...(input.role !== undefined ? { role: input.role } : {}),
    }
  }
  if (ctx.cwd !== undefined) {
    const manifestPath = join(ctx.cwd, ".agents", stripOwner(agent), "AGENT.md")
    const exists = ctx.manifestExists ?? existsSync
    if (exists(manifestPath)) {
      return {
        ok: true,
        agentId: agent,
        ...(input.role !== undefined ? { role: input.role } : {}),
      }
    }
  }
  if (ctx.roleNames.includes(agent)) {
    if (input.role !== undefined && input.role !== agent) {
      return {
        ok: false,
        code: "invalid_agent",
        message: `agent_start: "agent" ("${agent}") and "role" ("${input.role}") name different roles.`,
      }
    }
    return { ok: true, role: agent }
  }
  const known = ctx.roleNames.join(", ")
  const where =
    ctx.cwd === undefined
      ? "no working directory"
      : "no .agents/<id>/AGENT.md under the working directory"
  return {
    ok: false,
    code: "invalid_agent",
    message: `agent_start: no agent "${agent}": ${where} and no role of that name (known: ${known}).`,
  }
}
