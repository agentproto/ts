/**
 * Pure logic for flipping a live session between the terminal and
 * conversation harnesses. No vscode import so this is directly unit-testable.
 */

import type { SessionDescriptor } from "../client/types.js"

export type HarnessSwitchTarget = "terminal" | "conversation"

export interface HarnessSwitchPlan {
  target: HarnessSwitchTarget
  /** MCP `session_restart` overrides that force the agent-cli path. */
  overrides?: Record<string, unknown>
  disabledReason?: string
}

// Lists ONLY adapters that have a real `pty-native` restart strategy — a
// `RESUME_STRATEGIES` entry with `spawnArgs` (runtime/src/resume-strategies.ts).
// Only `claude-code` qualifies today; `decideRestartStrategy` can never return
// `pty-native` for an adapter absent here, so a switch to a PTY would silently
// yield another agent-cli session. Re-add `hermes` once it gains a `pty-native`
// strategy in `resume-strategies.ts`.
const NATIVE_RESUME_KEYS: Record<string, string> = {
  "claude-code": "claudeResumeId",
}

function parseResumeArgv(argv: readonly string[] | undefined): string | undefined {
  if (!argv) return undefined
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--resume" || argv[i] === "-r") return argv[i + 1]
  }
  return undefined
}

function nativeResumeId(session: Pick<SessionDescriptor, "adapterSlug" | "resumeMetadata">): string | undefined {
  const key = session.adapterSlug ? NATIVE_RESUME_KEYS[session.adapterSlug] : undefined
  if (!key) return undefined
  const value = session.resumeMetadata?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function recoverableConversationId(
  session: Pick<SessionDescriptor, "adapterSessionId" | "argv" | "resumeMetadata" | "adapterSlug">,
): string | undefined {
  return nativeResumeId(session) ?? parseResumeArgv(session.argv) ?? session.adapterSessionId
}

function forcedAgentOverride(
  session: Pick<
    SessionDescriptor,
    "mode" | "model" | "effort" | "contextProfile" | "posture" | "route" | "accessProfile"
  >,
): Record<string, unknown> | undefined {
  if (session.mode) return { mode: session.mode }
  if (session.model) return { model: session.model }
  if (session.effort) return { effort: session.effort }
  if (session.contextProfile) return { contextProfile: session.contextProfile }
  if (session.posture) return { posture: session.posture }
  if (session.route) return { route: session.route }
  if (session.accessProfile) return { access: { profileRef: session.accessProfile.profileRef } }
  return undefined
}

/**
 * Plan the harness flip for one session.
 *
 * Terminal/PTy sessions flip to conversation via a forced agent resume so the
 * daemon lands on ACP. Agent-cli sessions flip to terminal via the native
 * restart path, which will choose a pty-native resume when the provider id is
 * recoverable.
 */
export function planHarnessSwitch(session: SessionDescriptor): HarnessSwitchPlan {
  if (session.kind === "terminal" && session.pty === true) {
    const resumeId = recoverableConversationId(session)
    if (!resumeId) {
      return {
        target: "conversation",
        disabledReason:
          "this PTY session has no recoverable resume id yet — the switch to conversation needs `--resume`, `adapterSessionId`, or native resume metadata.",
      }
    }
    const overrides = forcedAgentOverride(session)
    if (!overrides) {
      return {
        target: "conversation",
        disabledReason:
          "this PTY session has no safe restart axis to force ACP resume with — there is nothing stable to reuse as an override.",
      }
    }
    return { target: "conversation", overrides }
  }

  if (session.kind === "agent-cli") {
    const key = session.adapterSlug ? NATIVE_RESUME_KEYS[session.adapterSlug] : undefined
    if (!key) {
      return {
        target: "terminal",
        disabledReason:
          "this agent adapter has no provider-native PTY resume strategy — the switch to a terminal needs an adapter with a pty-native restart strategy.",
      }
    }
    // The daemon's `session_restart` runs `augmentWithFsResume` before
    // `decideRestartStrategy`, recovering the native id from disk via the
    // `adapterSessionId` (which for claude-code IS the on-disk transcript uuid),
    // so a live session with an `adapterSessionId` is switchable even before the
    // graceful-exit sniffer has populated `resumeMetadata`. Mirrors the
    // `recoverableConversationId` fallback used for the PTY→conversation path.
    const recoverable = nativeResumeId(session) ?? session.adapterSessionId
    if (!recoverable) {
      return {
        target: "terminal",
        disabledReason:
          "this agent session has no native resume id and no adapter session id yet — the switch to a PTY needs a recoverable provider-native resume id.",
      }
    }
    return { target: "terminal" }
  }

  return {
    target: "conversation",
    disabledReason: "switch harness only applies to live terminal PTYs and agent-cli sessions.",
  }
}
