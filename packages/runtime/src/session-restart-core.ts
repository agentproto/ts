/**
 * Shared agent-session restart core — the "agent" branch of
 * `decideRestartStrategy` (resume-strategies.ts), factored out so both
 * the `session_restart` MCP tool (session-tools.ts) and the cron
 * scheduler's `prompt-session` action (cron-scheduler.ts) resume a dead
 * session via the exact same path. PTY strategies stay inline in
 * session-tools.ts — cron `prompt-session` jobs only ever target
 * agent-cli sessions.
 *
 * Lives in its own module (not resume-strategies.ts) because
 * resume-strategies.ts is deliberately duck-typed against a minimal
 * shape to avoid a value-level import of sessions.ts (see its own
 * top-of-file comment). This module needs the real `SessionsRegistry`
 * / `AgentAdapterResolver` types, so it can't share that constraint.
 */

import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"
import type { AgentAdapterResolver } from "./http-server.js"
import {
  decideRestartStrategy,
  augmentWithFsResume,
  describeResumePath,
} from "./resume-strategies.js"

export interface RestartAgentSessionResult {
  desc: SessionDescriptor
  resumedFrom: string
  resumeVia: string
  resumeFallback?: boolean
}

export interface RestartAgentSessionOptions {
  /**
   * Skip `decideRestartStrategy`'s PTY-native preference (e.g. claude-code's
   * `claude --resume <id>`, chosen whenever a native resume id is found —
   * see resume-strategies.ts) and always resume at the ACP level via
   * `prev.adapterSessionId` instead. A PTY-resumed session is a raw
   * terminal — it has no `sendPrompt`, only `writeTerminalInput` — so
   * any caller that needs to keep sending structured prompts to the
   * resumed session (the cron scheduler's `prompt-session` action) MUST
   * set this; there's nothing "less correct" about ACP resume for
   * claude-code specifically, it's simply the strategy that yields an
   * agent-cli session instead of a PTY one.
   */
  forceAgentResume?: boolean
}

/**
 * Resume an agent-cli session's conversation via provider-native or
 * ACP-level resume (never PTY — throws for `pty-native`/`pty-plain`/
 * `unsupported` strategies, unless `forceAgentResume` is set). Falls
 * back to a fresh spawn (no continuity) if the adapter rejects the
 * resume id with a "not found" error — same behaviour `session_restart`
 * has always had for a prior session that died before its first turn.
 */
export async function restartAgentSession(
  registry: SessionsRegistry,
  resolveAgentAdapter: AgentAdapterResolver,
  prev: SessionDescriptor,
  opts: RestartAgentSessionOptions = {},
): Promise<RestartAgentSessionResult> {
  const augmented = await augmentWithFsResume(prev)
  const strategy = opts.forceAgentResume
    ? ({ kind: "agent", resumeSessionId: prev.adapterSessionId } as const)
    : decideRestartStrategy(augmented)

  if (strategy.kind !== "agent") {
    throw new Error(
      `restartAgentSession: session '${prev.id}' resolved to a '${strategy.kind}' ` +
        "restart strategy — only agent-adapter sessions are resumable this way.",
    )
  }

  const adapterSlug = prev.adapterSlug
  if (!adapterSlug) {
    throw new Error(
      "restartAgentSession: internal error — agent resume strategy without adapterSlug",
    )
  }

  const resolved = await resolveAgentAdapter(adapterSlug)
  if (!resolved) {
    throw new Error(`restartAgentSession: adapter '${adapterSlug}' not found.`)
  }

  let cwd = prev.cwd
  if (!cwd) {
    cwd = process.cwd()
    console.warn(
      `[restartAgentSession] no cwd on prior descriptor ${prev.id} — falling back to daemon's cwd ${cwd}`,
    )
  }

  const spawnWithResume = async (
    resumeSessionId?: string,
  ): Promise<SessionDescriptor> => {
    let liveSessionId: string | undefined
    const agentSession = await resolved.startSession({
      cwd,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(prev.model ? { model: prev.model } : {}),
      ...(prev.mcpServers ? { mcpServers: prev.mcpServers } : {}),
      onActivity: () => {
        if (liveSessionId) registry.pulseActivity(liveSessionId)
      },
    })
    const desc = registry.spawnAgent({
      workspaceSlug: prev.workspaceSlug,
      cwd,
      agentSession,
      adapterSlug,
      ...(prev.label ? { label: prev.label } : {}),
      ...(prev.mcpServers ? { mcpServers: prev.mcpServers } : {}),
      ...(prev.model ? { model: prev.model } : {}),
      ...(resolved.commandPreview ? { commandPreview: resolved.commandPreview } : {}),
    })
    liveSessionId = desc.id
    return desc
  }

  let desc: SessionDescriptor
  let resumeFallback = false
  try {
    desc = await spawnWithResume(strategy.resumeSessionId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (strategy.resumeSessionId && /not found|Resource not found/i.test(msg)) {
      desc = await spawnWithResume(undefined)
      resumeFallback = true
    } else {
      throw err
    }
  }

  // `describeResumePath` reports whatever `decideRestartStrategy` would
  // naturally prefer (e.g. claude-code's native `claude --resume`, if a
  // resume id was found on disk) — misleading when `forceAgentResume`
  // skipped that preference and went straight to ACP resume instead.
  const resumeVia = resumeFallback
    ? ""
    : opts.forceAgentResume
      ? "resumed via ACP"
      : describeResumePath(augmented)

  return {
    desc,
    resumedFrom: prev.id,
    resumeVia,
    ...(resumeFallback ? { resumeFallback: true } : {}),
  }
}
