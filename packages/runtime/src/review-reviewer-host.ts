/**
 * The daemon's {@link ReviewerSessionHost}: agent review lanes as CHILD
 * SESSIONS, spawned through the same `spawnAgentSession` core `agent_start`
 * uses, waited on with the same `monitorSessionWait` core `session_monitor` /
 * `sessions wait` use, and stopped through `registry.kill` — the normal
 * session lifecycle, so a timed-out or cancelled reviewer is a killed session
 * in `session_list`, never an orphan pid.
 *
 * A lane's `preset` names the daemon's existing preset surface — no parallel
 * model/auth config: first a harness preset (`harness-presets.json`: adapter
 * harness + auth profile + default model), then a user preset
 * (`presets.json`, handed to `spawnAgentSession` as-is so it expands the
 * preset exactly like `agent_start.presetId` does).
 *
 * Reviewers spawn with role `executor` (no re-delegation), `worktree: false`
 * (they read the reviewed checkout's history; they never edit), and
 * `dedupe: false` (two lanes/runs with the same label are distinct
 * reviewers, never merged).
 */

import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { EventRing } from "./event-ring.js"
import type { AgentAdapterResolver } from "./http-server.js"
import { spawnAgentSession, type SpawnAgentSessionDeps, type SpawnAgentSessionInput } from "./session-spawn.js"
import { monitorSessionWait } from "./orchestration-tools.js"
import { getHarnessPreset, type HarnessPreset } from "./harness-preset-store.js"
import { getUserPreset, type UserPreset } from "./user-presets.js"
import type { ReviewerRunResult, ReviewerSessionHost } from "./review-runner.js"

export interface DaemonReviewerHostDeps {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  eventRing: EventRing
  resolveAgentAdapter: AgentAdapterResolver
  /** Extra spawn deps forwarded to `spawnAgentSession` (sandbox resolver,
   *  catalog models, …). `registry`/`resolveAgentAdapter` always win. */
  spawnDeps?: Partial<SpawnAgentSessionDeps>
  /** Preset lookups — injectable for tests; default to the real stores. */
  getHarnessPreset?: (id: string) => Promise<HarnessPreset | undefined>
  getUserPreset?: (id: string) => Promise<UserPreset | undefined>
}

/** Resolve a lane's `preset` to spawn fields — harness preset first, then a
 *  user preset. `undefined` when neither store knows the id. */
export async function resolveReviewerPreset(
  preset: string,
  lookups: Pick<DaemonReviewerHostDeps, "getHarnessPreset" | "getUserPreset"> = {},
): Promise<Pick<SpawnAgentSessionInput, "adapter" | "model" | "access" | "preset"> | undefined> {
  const harness = await (lookups.getHarnessPreset ?? getHarnessPreset)(preset)
  if (harness) {
    return { adapter: harness.harnessSlug, model: harness.defaultModel, access: { profileRef: harness.profileRef } }
  }
  const user = await (lookups.getUserPreset ?? getUserPreset)(preset)
  const adapter = user?.adapter ?? user?.harness
  if (user && adapter) return { adapter, preset: user }
  return undefined
}

export function createDaemonReviewerHost(deps: DaemonReviewerHostDeps): ReviewerSessionHost {
  const { registry, sessionEvents, eventRing } = deps
  return {
    async run(input): Promise<ReviewerRunResult> {
      const spawnFields = await resolveReviewerPreset(input.preset, deps)
      if (!spawnFields) {
        return {
          status: "failed",
          preset: input.preset,
          error: `preset '${input.preset}' not found — neither a harness preset (harness_preset_list) nor a user preset`,
        }
      }
      if (input.signal?.aborted) {
        return { status: "failed", preset: input.preset, error: "review cancelled before the reviewer spawned" }
      }
      // Cursor BEFORE the spawn: the wait below replays from here, so a
      // reviewer whose turn ends before we subscribe is still seen.
      const since = eventRing.since(Number.MAX_SAFE_INTEGER, { limit: 0 }).nextCursor
      const spawned = await spawnAgentSession(
        { ...deps.spawnDeps, registry, resolveAgentAdapter: deps.resolveAgentAdapter },
        {
          ...spawnFields,
          cwd: input.cwd,
          prompt: input.prompt,
          label: input.label,
          role: "executor",
          origin: "review",
          worktree: false,
          dedupe: false,
          ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        },
      )
      if (!spawned.ok) {
        return { status: "failed", preset: input.preset, error: `reviewer spawn failed (${spawned.code}): ${spawned.message}` }
      }
      const sessionId = spawned.descriptor.id
      const kill = () => {
        try {
          registry.kill(sessionId)
        } catch {
          // already gone
        }
      }
      // Cancel = kill through the lifecycle; the kill's `session:exited`
      // settles the wait below.
      const onAbort = () => kill()
      input.signal?.addEventListener("abort", onAbort, { once: true })
      // An abort that landed WHILE the spawn was in flight fired before the
      // listener existed — honour it now.
      if (input.signal?.aborted) kill()
      try {
        const res = await monitorSessionWait({
          registry,
          sessionEvents,
          eventRing,
          sessionIds: [sessionId],
          event: "any",
          timeoutMs: input.timeoutMs,
          since,
        })
        if (res.timedOut) return { status: "timeout", sessionId, preset: input.preset }
        if (input.signal?.aborted) {
          return { status: "failed", sessionId, preset: input.preset, error: "review cancelled while the reviewer was running" }
        }
        if (res.event === "exited") {
          const status = registry.get(sessionId)?.status ?? res.status
          return {
            status: "failed",
            sessionId,
            preset: input.preset,
            error: `reviewer session exited before finishing its turn (status '${status ?? "unknown"}')`,
          }
        }
        if (res.event === "turn-end" && (res.empty || res.reason === "error")) {
          return {
            status: "failed",
            sessionId,
            preset: input.preset,
            error: res.empty
              ? "reviewer produced an empty turn (commonly an auth failure or an invalid model id)"
              : "reviewer's turn ended with reason 'error' (commonly an auth failure)",
          }
        }
        return { status: "ended", sessionId, preset: input.preset }
      } finally {
        input.signal?.removeEventListener("abort", onAbort)
        // One-shot reviewer: its verdict is on disk (or it failed) — release
        // the adapter process. The session row and transcript stay
        // inspectable.
        kill()
      }
    },
  }
}
