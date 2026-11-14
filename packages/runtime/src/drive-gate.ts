/**
 * `checkDrive`: the one drive decision the five drive tools call.
 *
 * It builds the principal and the `PermissionContext` the same way the
 * messaging entry points do (registry lookups + explicit grants under
 * `defaults.messaging.grants`), then calls `decide(principal, "session.drive",
 * ...)`. The legacy owner-gate rules live in `session-owner.ts` and are
 * evaluated unchanged by `decide()`; a matching `session:prompt` /
 * `session:control` grant can admit a caller the owner gate refuses.
 */

import type { Grant } from "@agentproto/policy"

import { buildSessionGrantContext } from "./messaging-context.js"
import { decide, type SessionResource } from "./permissions.js"
import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"
import { createWorkspaceOfCwd } from "./workspace-binding.js"

/** Which AIP-38 action each drive tool is decided under. */
export const DRIVE_TOOL_ACTIONS: Readonly<Record<string, "session:prompt" | "session:control">> = {
  agent_prompt: "session:prompt",
  agent_interrupt: "session:control",
  agent_kill: "session:control",
  session_restart: "session:control",
  session_continue_fresh: "session:control",
}

export interface CheckDriveInput {
  registry: Pick<SessionsRegistry, "get">
  grants?: readonly Grant[]
  /** Effective calling session id, or undefined for the human operator. */
  callerSessionId: string | undefined
  /** The target session. */
  target: SessionDescriptor
  /** MCP tool name. An unknown name maps to `session:control`. */
  tool: string
  /** cwd to registered-workspace-slug lookup behind a `workspace:<slug>`
   *  grant scope. Default: the workspaces config, read lazily and only when a
   *  grant is actually evaluated (the owner gate refused the call). */
  workspaceOfCwd?: (cwd: string) => string | undefined
}

export function checkDrive(
  input: CheckDriveInput,
): { ok: true } | { ok: false; message: string } {
  const action = DRIVE_TOOL_ACTIONS[input.tool] ?? "session:control"
  const principal =
    input.callerSessionId === undefined
      ? ({ kind: "operator", via: "anonymous-local" } as const)
      : ({
          kind: "session",
          // An id the registry does not hold is still a session principal:
          // the legacy gate only needs the id.
          session: input.registry.get(input.callerSessionId) ?? { id: input.callerSessionId },
        } as const)
  const resource: SessionResource = {
    kind: "session",
    session: input.target,
    drive: { tool: input.tool, action },
  }
  let resolved: ((cwd: string) => string | undefined) | undefined
  const workspaceOfCwd =
    input.workspaceOfCwd ?? ((cwd: string) => (resolved ??= createWorkspaceOfCwd())(cwd))
  const d = decide(principal, "session.drive", resource, {
    ...buildSessionGrantContext(input),
    workspaceOfCwd,
  })
  return d.allow ? { ok: true } : { ok: false, message: d.reason }
}
