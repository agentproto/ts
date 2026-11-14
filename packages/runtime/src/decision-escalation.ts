/**
 * The ONE harness escalation of the staged decision workflow. The workflow
 * step (the parent) owns it: it validates the target against the execution
 * profile BEFORE anything spawns, spawns a single read-only session through
 * the same `spawnAgentSession` core `agent_start` uses, waits once on a
 * deadline, and always kills + archives the session and removes its scratch
 * directory. There is no retry, no fallback model and no fan-out: a failed
 * attempt is recorded and the policy's conservative default applies.
 *
 * Tool limits are reported as they are, not as they are hoped to be. The
 * session is spawned with `mcpServers: []` (no daemon tools mounted) and the
 * canonical `read-only` posture; whether that posture is NATIVE (the harness
 * enforces it) or only a prompt preamble is read back from the live session
 * and recorded in `toolControls`. The harness's own built-in tools are not
 * disabled by this module and the record says so.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxMode } from "@agentproto/command-sandbox"
import { postureEnforcement } from "./canonical-posture.js"
import type { EscalationOutcome } from "@agentproto/decision"
import { validateSpawnTarget, type DecisionExecProfile, type ResolvedTarget } from "./decision-profile.js"
import type { EventRing } from "./event-ring.js"
import { monitorSessionWait } from "./orchestration-tools.js"
import type { SessionEventBus } from "./session-event-bus.js"
import { cleanAgentLines, spawnAgentSession, type SpawnAgentSessionDeps } from "./session-spawn.js"
import type { AgentAdapterResolver } from "./http-server.js"
import type { SessionsRegistry } from "./sessions.js"

export type EscalationWait =
  | "none"
  | "turn"
  | "timeout"
  | "cancelled"
  | "provider-unavailable"
  | "human-input-required"
  | "exited"

export interface ToolControls {
  /** What was asked of the harness. */
  readonly configured: {
    readonly posture: "read-only"
    readonly mcpServers: "none"
    readonly commandSandbox?: SandboxMode
  }
  /** What the live session proves it enforces. */
  readonly enforced: {
    readonly posture: "native" | "spawn-config" | "prompt-advisory" | "none" | "unknown"
    readonly mcpServers: "none-mounted"
    readonly commandSandbox: "requested" | "not-requested"
    /** Always true: this module does not disable the harness's built-in tools. */
    readonly harnessBuiltinToolsAvailable: true
  }
}

export interface EscalationHostRun {
  readonly spawn: Extract<ResolvedTarget, { ok: true }>["spawn"]
  readonly prompt: string
  readonly label: string
  readonly timeoutMs: number
  readonly owner: { readonly runId: string; readonly workflowId: string; readonly stepId: string }
  readonly parentSessionId?: string
  readonly commandSandbox?: SandboxMode
  readonly signal?: AbortSignal
}

export type EscalationHostResult =
  | { readonly status: "ended"; readonly text: string; readonly sessionId: string; readonly model?: string; readonly toolControls: ToolControls }
  | {
      readonly status: "timeout" | "cancelled" | "failed"
      readonly wait: EscalationWait
      readonly error: string
      readonly sessionId?: string
      readonly model?: string
      readonly toolControls?: ToolControls
    }

/** Seam the workflow tools run the escalation through (a fake in tests). */
export interface EscalationHost {
  run(input: EscalationHostRun): Promise<EscalationHostResult>
}

export interface DaemonEscalationHostDeps {
  readonly registry: SessionsRegistry
  readonly sessionEvents: SessionEventBus
  readonly eventRing: EventRing
  readonly resolveAgentAdapter: AgentAdapterResolver
  readonly spawnDeps?: Partial<SpawnAgentSessionDeps>
  /** Profile re-checked against the LIVE session's reported model. */
  readonly profile: DecisionExecProfile
}

const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}…` : s)

export function createDaemonEscalationHost(deps: DaemonEscalationHostDeps): EscalationHost {
  const { registry, sessionEvents, eventRing } = deps
  return {
    async run(input) {
      if (input.signal?.aborted) {
        return { status: "cancelled", wait: "cancelled", error: "cancelled before the escalation session spawned" }
      }
      let scratch: string | undefined
      let sessionId: string | undefined
      const kill = () => {
        if (!sessionId) return
        try {
          registry.kill(sessionId)
        } catch {
          // already gone
        }
      }
      const onAbort = () => kill()
      try {
        // Scratch cwd: the session never sees the reviewed checkout. The
        // evidence it needs is in the prompt packet.
        scratch = await mkdtemp(join(tmpdir(), "agp-decision-escalate-"))
        const since = eventRing.since(Number.MAX_SAFE_INTEGER, { limit: 0 }).nextCursor
        const spawned = await spawnAgentSession(
          { ...deps.spawnDeps, registry, resolveAgentAdapter: deps.resolveAgentAdapter },
          {
            ...input.spawn,
            cwd: scratch,
            prompt: input.prompt,
            label: input.label,
            role: "executor",
            origin: "workflow",
            posture: "read-only",
            mcpServers: [],
            contextContinuity: { mode: "manual" },
            worktree: false,
            dedupe: false,
            workflowOwner: input.owner,
            ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
            ...(input.commandSandbox ? { commandSandbox: input.commandSandbox } : {}),
          },
        )
        if (!spawned.ok) {
          return { status: "failed", wait: "provider-unavailable", error: `spawn failed (${spawned.code}): ${clip(spawned.message)}` }
        }
        sessionId = spawned.descriptor.id
        input.signal?.addEventListener("abort", onAbort, { once: true })
        if (input.signal?.aborted) kill()

        // The live session is the proof of identity: whatever the spawn core
        // resolved (config defaults can fill gaps) must still be entitled.
        const desc = registry.get(sessionId)
        const liveModel = desc?.activeModel ?? desc?.model
        const liveAdapter = desc?.adapterSlug
        const identity = validateSpawnTarget(deps.profile, {
          adapter: liveAdapter ?? input.spawn.adapter,
          model: liveModel ?? input.spawn.model,
          route: desc?.route,
        })
        if (!identity.ok) {
          kill()
          return {
            status: "failed",
            wait: "none",
            error: `spawned session identity refused (${identity.code}): ${identity.reason}`,
            sessionId,
            ...(liveModel ? { model: liveModel } : {}),
          }
        }
        const enforcement = postureEnforcement(
          "read-only",
          desc?.availableModes ?? [],
          desc?.spawnEnforcedPostures ?? [],
        )
        const toolControls: ToolControls = {
          configured: {
            posture: "read-only",
            mcpServers: "none",
            ...(input.commandSandbox ? { commandSandbox: input.commandSandbox } : {}),
          },
          enforced: {
            posture: enforcement === "unavailable" ? "unknown" : enforcement,
            mcpServers: "none-mounted",
            commandSandbox: input.commandSandbox ? "requested" : "not-requested",
            harnessBuiltinToolsAvailable: true,
          },
        }

        const res = await monitorSessionWait({
          registry,
          sessionEvents,
          eventRing,
          sessionIds: [sessionId],
          event: "any",
          timeoutMs: input.timeoutMs,
          since,
        })
        const model = (() => {
          const d = registry.get(sessionId!)
          return d?.activeModel ?? d?.model ?? input.spawn.model
        })()
        const base = { sessionId, ...(model ? { model } : {}), toolControls }
        if (res.timedOut) {
          return { status: "timeout", wait: "timeout", error: `escalation exceeded ${input.timeoutMs}ms and was killed`, ...base }
        }
        if (input.signal?.aborted) {
          return { status: "cancelled", wait: "cancelled", error: "escalation cancelled while the session was running", ...base }
        }
        if (res.event === "awaiting-input") {
          return {
            status: "failed",
            wait: "human-input-required",
            error: "the escalation session asked for human input — not answered here; the policy default applies",
            ...base,
          }
        }
        if (res.event === "exited") {
          return { status: "failed", wait: "exited", error: `escalation session exited before finishing its turn (status '${res.status ?? "unknown"}')`, ...base }
        }
        if (res.event === "turn-end" && res.reason === "error") {
          return {
            status: "failed",
            wait: "provider-unavailable",
            error: res.error ? `escalation turn ended with reason 'error': ${clip(res.error)}` : "escalation turn ended with reason 'error'",
            ...base,
          }
        }
        if (res.event === "turn-end" && res.empty) {
          return { status: "failed", wait: "provider-unavailable", error: "escalation produced an empty turn (commonly an auth failure or an invalid model id)", ...base }
        }
        // Live model may have drifted from the validated one mid-turn.
        const post = validateSpawnTarget(deps.profile, { adapter: registry.get(sessionId)?.adapterSlug ?? input.spawn.adapter, model })
        if (!post.ok) {
          return { status: "failed", wait: "none", error: `session ran on a model the profile refuses (${post.code}): ${post.reason}`, ...base }
        }
        const lines: string[] = []
        const unsub = registry.attach(sessionId, line => {
          lines.push(line)
        })
        unsub?.()
        return { status: "ended", text: cleanAgentLines(lines).join("\n").trim(), ...base }
      } finally {
        input.signal?.removeEventListener("abort", onAbort)
        kill()
        if (sessionId) {
          try {
            if (!registry.get(sessionId)?.archived) registry.archiveSession(sessionId)
          } catch {
            // best-effort: a refused archive leaves the row visible
          }
        }
        if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}

// ── prompt + reply ────────────────────────────────────────────────────────

export function buildEscalationPrompt(packet: string, choices: readonly string[]): string {
  return [
    "You are a routing classifier. Do not use tools, do not read or write files, do not run commands.",
    "Read the packet below and choose exactly ONE value from the closed list.",
    `Allowed choices: ${choices.join(" | ")}`,
    "When evidence is thin or ambiguous, prefer the more thorough option.",
    'Answer with ONE line of JSON and nothing after it: {"choice":"<CHOICE>"} where <CHOICE> is one allowed value.',
    "",
    "--- packet ---",
    packet,
  ].join("\n")
}

/** Last JSON object in `text` carrying a string `choice`, accepted only when it
 *  is inside the closed set. Anything else is a failed escalation. */
export function parseEscalationReply(
  text: string,
  choices: readonly string[],
): { readonly ok: true; readonly choice: string } | { readonly ok: false; readonly error: string } {
  const candidates = [...text.matchAll(/\{[^{}]*\}/g)]
  for (let i = candidates.length - 1; i >= 0; i--) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidates[i]![0])
    } catch {
      continue
    }
    if (parsed && typeof parsed === "object" && typeof (parsed as { choice?: unknown }).choice === "string") {
      const choice = (parsed as { choice: string }).choice.trim()
      if (choices.includes(choice)) return { ok: true, choice }
      return { ok: false, error: `reply named "${choice}", which is not an allowed choice` }
    }
  }
  return { ok: false, error: "reply held no {\"choice\":…} object" }
}

// ── the bounded escalation dep ────────────────────────────────────────────

export interface EscalationRecord {
  attempted: boolean
  status: "not-attempted" | "decided" | "refused" | "failed" | "timeout" | "cancelled" | "invalid-reply"
  wait: EscalationWait
  reason?: string
  adapter?: string
  /** Model the profile validated before spawn. */
  model?: string
  /** Model the live session reported. */
  actualModel?: string
  profileRef?: string
  sessionId?: string
  toolControls?: ToolControls
  durationMs?: number
}

export interface BoundedEscalation {
  /** `decide()`'s `escalate` dep. Spawns at most once, ever. */
  readonly escalate: (input: { packet: string }) => Promise<EscalationOutcome>
  readonly record: () => EscalationRecord
}

/** One escalation attempt against an already-validated target. A second call
 *  is refused (the workflow step has no retry), and every failure is returned
 *  as data, never thrown. */
export function createBoundedEscalation(opts: {
  readonly host: EscalationHost
  readonly target: Extract<ResolvedTarget, { ok: true }>
  readonly choices: readonly string[]
  readonly timeoutMs: number
  readonly owner: EscalationHostRun["owner"]
  readonly label: string
  readonly parentSessionId?: string
  readonly commandSandbox?: SandboxMode
  readonly signal?: AbortSignal
  readonly now?: () => number
}): BoundedEscalation {
  const now = opts.now ?? Date.now
  let used = false
  const rec: EscalationRecord = {
    attempted: false,
    status: "not-attempted",
    wait: "none",
    adapter: opts.target.adapter,
    model: opts.target.model,
    ...(opts.target.profileRef ? { profileRef: opts.target.profileRef } : {}),
  }
  return {
    record: () => ({ ...rec }),
    async escalate({ packet }) {
      if (used) return { ok: false, error: "escalation limit reached (one attempt per run)" }
      used = true
      rec.attempted = true
      const started = now()
      let res: EscalationHostResult
      try {
        res = await opts.host.run({
          spawn: opts.target.spawn,
          prompt: buildEscalationPrompt(packet, opts.choices),
          label: opts.label,
          timeoutMs: opts.timeoutMs,
          owner: opts.owner,
          ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
          ...(opts.commandSandbox ? { commandSandbox: opts.commandSandbox } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        })
      } catch (e) {
        res = { status: "failed", wait: "provider-unavailable", error: e instanceof Error ? e.message : String(e) }
      }
      rec.durationMs = now() - started
      if (res.sessionId) rec.sessionId = res.sessionId
      if (res.model) rec.actualModel = res.model
      if (res.toolControls) rec.toolControls = res.toolControls
      if (res.status !== "ended") {
        rec.status = res.status === "failed" ? "failed" : res.status
        rec.wait = res.wait
        rec.reason = res.error
        return { ok: false, error: res.error }
      }
      const parsed = parseEscalationReply(res.text, opts.choices)
      if (!parsed.ok) {
        rec.status = "invalid-reply"
        rec.wait = "turn"
        rec.reason = parsed.error
        return { ok: false, error: parsed.error }
      }
      rec.status = "decided"
      rec.wait = "turn"
      return { ok: true, choice: parsed.choice }
    },
  }
}
