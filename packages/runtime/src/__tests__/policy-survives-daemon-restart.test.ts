import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createCompletionPolicySupervisor } from "../supervisor.js"

/**
 * Ordering regression (§5 of the session-survivability plan).
 *
 * At boot the registry reclassifies every previously-running row to
 * `killed`/`endedReason:"daemon-restart"` and emits `session:exited` for it —
 * DURING registry construction, i.e. BEFORE the supervisor is built and
 * re-arms its persisted policies (the real order in `createGateway`:
 * registry first, supervisor second). A lone-session completion policy
 * therefore must NOT be cancelled by that restart: the session is resumable
 * in place (lazily on next prompt, or eagerly in PR-4), and the policy has to
 * survive to gate on the resumed session's next turn-end.
 *
 * This test pins that invariant so a future refactor can't silently cancel
 * every policy at boot (whether by re-ordering construction so the live
 * `session:exited` is heard, or by treating the killed ghost as absent at
 * reload).
 */
describe("completion policy survives a daemon restart (§5 ordering)", () => {
  let tmp: string
  let sessionsPath: string
  let policiesPath: string
  let workspace: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "policy-restart-"))
    sessionsPath = join(tmp, "sessions.json")
    policiesPath = join(tmp, "policies.json")
    workspace = tmp
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    writeFileSync(
      join(workspace, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: ["true"] }),
      "utf8",
    )
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("a lone-session policy on an idle watched session is NOT cancelled by boot reclassification", async () => {
    const sessionId = "sess_idlewatch"
    // Prior daemon: an idle-but-running agent-cli session (busy:false, so it
    // died between turns — nothing was interrupted, only liveness was lost).
    writeFileSync(
      sessionsPath,
      JSON.stringify({
        savedAt: "2026-07-23T00:00:00Z",
        sessions: [
          {
            id: sessionId,
            kind: "agent-cli",
            workspaceSlug: "default",
            command: "claude (agent)",
            pid: null,
            status: "running",
            startedAt: "2026-07-23T00:00:00Z",
            busy: false,
            adapterSlug: "claude-code",
            adapterSessionId: "acp-idle",
            cwd: workspace,
          },
        ],
      }),
    )
    // Prior daemon also persisted a lone-session completion policy watching it.
    writeFileSync(
      policiesPath,
      JSON.stringify({
        policies: [
          {
            input: { sessionId, gate: { command: "true" }, then: "emit" },
            state: {
              policyId: "pol_idlewatch",
              sessionId,
              sessionIds: [sessionId],
              pending: [sessionId],
              status: "watching",
              startedAt: "2026-07-23T00:00:00Z",
              retries: 0,
            },
          },
        ],
      }),
    )

    const bus = createSessionEventBus()
    // Real boot order: registry FIRST. Its construction reclassifies the row
    // and emits session:exited{daemon-restart} — with no supervisor yet alive
    // to hear it.
    const reg = createSessionsRegistry({ persistPath: sessionsPath, sessionEvents: bus })
    expect(reg.get(sessionId)?.status).toBe("killed")
    expect(reg.get(sessionId)?.endedReason).toBe("daemon-restart")

    // ... THEN the supervisor is built and re-arms from its own persist file.
    const supervisor = createCompletionPolicySupervisor({
      registry: reg,
      sessionEvents: bus,
      workspace,
      persistPath: policiesPath,
    })
    // Let any async transition settle.
    await new Promise(res => setTimeout(res, 30))

    // The policy must survive — the restart cost this session its liveness,
    // not its policy. A silent cancel here would strand every re-armed
    // lone-session gate after a daemon restart.
    const status = supervisor.getStatus("pol_idlewatch")?.status
    expect(status).not.toBe("cancelled")
    expect(status).toBe("watching")
    reg.shutdown()
  })
})
