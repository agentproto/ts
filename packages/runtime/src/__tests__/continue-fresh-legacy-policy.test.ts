import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCheckpointSources } from "../checkpoint-extract.js"
import { CONTEXT_CONTINUITY_DEFAULTS } from "../context-continuity.js"
import { continueAgentSessionFresh } from "../session-continue-fresh.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionDescriptor } from "../sessions.js"
import { createCompletionPolicySupervisor, policyWatchesSession, type PolicyRunState } from "../supervisor.js"

vi.mock("../session-spawn.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../session-spawn.js")>()
  return { ...mod, spawnAgentSession: vi.fn() }
})

import { spawnAgentSession } from "../session-spawn.js"

/**
 * Regression: `session_continue_fresh` failed with
 * `Cannot read properties of undefined (reading 'includes')`.
 *
 * The daemon's policies.json still held terminal policies persisted before
 * the fan-in `sessionIds` field existed. Reload kept those terminal states
 * verbatim, so `supervisor.list()` handed out states without `sessionIds`,
 * and the checkpoint builder's `lastGate` lookup (`policyWatchesSession`)
 * crashed on the first one — for ANY session, whatever its askSource /
 * role / worktree.
 */
describe("continue fresh with legacy persisted policies", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cf-legacy-policy-"))
    vi.mocked(spawnAgentSession).mockReset()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function bootSupervisor() {
    // Shapes copied from a real ~/.agentproto/policies.json: pre-fan-in
    // terminal states carry `sessionId` but neither `sessionIds` nor `pending`.
    const policiesPath = join(tmp, "policies.json")
    writeFileSync(
      policiesPath,
      JSON.stringify({
        policies: [
          {
            input: { sessionId: "sess_test", gate: { command: "true" }, then: "emit" },
            state: {
              policyId: "policy_aed74755",
              sessionId: "sess_test",
              status: "cancelled",
              retries: 2,
              startedAt: "2026-06-21T12:27:10.936Z",
              lastGate: { exitCode: 1, at: "2026-06-21T12:30:27.277Z" },
              endedAt: "2026-06-21T13:38:52.345Z",
              error: "session absent at reload",
            },
          },
          {
            input: { sessionId: "sess_old", gate: { command: "true" }, then: "emit" },
            state: {
              policyId: "policy_ab280871",
              sessionId: "sess_old",
              status: "done",
              retries: 0,
              startedAt: "2026-06-21T12:30:27.274Z",
              endedAt: "2026-06-21T12:30:27.274Z",
            },
          },
        ],
      }),
    )
    const bus = createSessionEventBus()
    const registry = createSessionsRegistry({ persistPath: join(tmp, "sessions.json"), sessionEvents: bus })
    const supervisor = createCompletionPolicySupervisor({
      registry,
      sessionEvents: bus,
      workspace: tmp,
      persistPath: policiesPath,
    })
    return { registry, supervisor }
  }

  it("normalizes sessionIds/pending on reloaded terminal policies", () => {
    const { registry, supervisor } = bootSupervisor()
    const states = supervisor.list()
    expect(states).toHaveLength(2)
    for (const s of states) {
      expect(s.sessionIds).toEqual([s.sessionId])
      expect(s.pending).toEqual([])
    }
    registry.shutdown()
  })

  it("policyWatchesSession tolerates a state without sessionIds", () => {
    const legacy = { policyId: "p", sessionId: "sess_a", status: "done" } as unknown as PolicyRunState
    expect(policyWatchesSession(legacy, "sess_a")).toBe(true)
    expect(policyWatchesSession(legacy, "sess_b")).toBe(false)
  })

  it("continues a claude-code executor session fresh (askSource:false) without crashing", async () => {
    const { registry, supervisor } = bootSupervisor()
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: { id: "sess_fresh" } as SessionDescriptor,
    })

    // Shaped like sess_a6b9cfd1: claude-code agent-cli on claude-sonnet-5-5,
    // subscription profile, native worktree, executor role, idle at 78% with
    // contextContinuity "ask".
    const prev = {
      id: "sess_a6b9cfd1",
      kind: "agent-cli",
      workspaceSlug: "agentproto",
      command: "claude (agent)",
      pid: 4242,
      status: "running",
      busy: false,
      startedAt: "2026-10-08T09:20:37.340Z",
      label: "fix-retired-sessions-daemon",
      title: "fix-retired-sessions-daemon",
      adapterSlug: "claude-code",
      harness: "claude-code",
      model: "claude-sonnet-5-5",
      cwd: tmp,
      worktreePath: tmp,
      worktreeId: "retired-sessions-never-revive",
      worktreeAutoProvisioned: true,
      accessProfile: { profileRef: "claude-subs-agentik" },
      contextSize: 200_000,
      contextUsed: 156_000,
      contextContinuity: { ...CONTEXT_CONTINUITY_DEFAULTS },
      meta: { role: "executor" },
    } as unknown as SessionDescriptor

    const result = await continueAgentSessionFresh(
      { registry, resolveAgentAdapter: vi.fn() } as unknown as SpawnAgentSessionDeps,
      prev,
      {
        baseDir: tmp,
        askSource: false,
        notes: "Pick up at the reviewer's forceResume comment.",
        sources: createCheckpointSources({ supervisor }),
      },
    )

    expect(result.continuedFrom).toBe("sess_a6b9cfd1")
    const [, input] = vi.mocked(spawnAgentSession).mock.calls[0]!
    expect(input.model).toBe("claude-sonnet-5-5")
    expect(input.access).toEqual({ profileRef: "claude-subs-agentik" })
    expect(input.prompt).toContain("Pick up at the reviewer's forceResume comment.")
    registry.shutdown()
  })
})
