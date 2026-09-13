import { describe, it, expect, vi } from "vitest"
import type { DaemonClient } from "../agent-session-host.js"
import { makeDaemonAgentSessionHost } from "../agent-session-host.js"

function fakeClient(overrides: Partial<DaemonClient> = {}): DaemonClient {
  return {
    start: vi.fn(async () => ({ id: "sess_1", status: "running", startedAt: "now" })),
    prompt: vi.fn(async () => {}),
    output: vi.fn(async () => ""),
    kill: vi.fn(async () => {}),
    waitForAny: vi.fn(async () => ({ sessionId: "sess_1", event: "turn-end" as const })),
    currentEventsCursor: vi.fn(async () => 0),
    close: vi.fn(async () => {}),
    ...overrides,
  }
}

/** Real daemon shape for a clean `session_monitor` timeout — no `event` field. */
function timedOutResult(sessionId: string) {
  return { timedOut: true as const, sessionIds: [sessionId] }
}

describe("makeDaemonAgentSessionHost", () => {
  it("spawn calls agent_start (client.start) with cwd/workspaceSlug/label, returns the session id", async () => {
    const client = fakeClient()
    const host = makeDaemonAgentSessionHost(client)
    const sessionId = await host.spawn("claude-code", { cwd: "/tmp/wt", workspaceSlug: "ws", stepId: "code" })
    expect(sessionId).toBe("sess_1")
    expect(client.start).toHaveBeenCalledWith({
      adapter: "claude-code",
      cwd: "/tmp/wt",
      workspaceSlug: "ws",
      label: "code",
    })
  })

  it("resolveByLabel returns the session id spawned under that step id", async () => {
    const client = fakeClient()
    const host = makeDaemonAgentSessionHost(client)
    expect(host.resolveByLabel("code")).toBeUndefined()
    await host.spawn("claude-code", { cwd: "/tmp/wt", stepId: "code" })
    expect(host.resolveByLabel("code")).toBe("sess_1")
  })

  it("sendPromptAndWait captures a cursor, THEN sends the prompt, THEN waits with that cursor as `since`", async () => {
    const order: string[] = []
    const client = fakeClient({
      currentEventsCursor: vi.fn(async () => {
        order.push("cursor")
        return 7
      }),
      prompt: vi.fn(async () => {
        order.push("prompt")
      }),
      waitForAny: vi.fn(async () => {
        order.push("wait-settled")
        return { sessionId: "sess_1", event: "turn-end" as const }
      }),
    })
    const host = makeDaemonAgentSessionHost(client)
    await host.sendPromptAndWait("sess_1", "do the thing")
    expect(client.prompt).toHaveBeenCalledWith("sess_1", "do the thing")
    // The cursor is captured — a completed, AWAITED round-trip — strictly
    // BEFORE the prompt is sent, so a turn that settles synchronously
    // inside `prompt`'s own round-trip is still caught by the daemon's
    // ring-replay branch regardless of when `waitForAny`'s own
    // subscription reaches it. This is race-free client-ordering can't be
    // (two outbound requests racing the same daemon have no guaranteed
    // arrival order) — see `HarnessClient.currentEventsCursor`'s doc.
    expect(order).toEqual(["cursor", "prompt", "wait-settled"])
    expect(client.prompt).toHaveBeenCalledTimes(1)
    expect(client.waitForAny).toHaveBeenCalledTimes(1)
    expect(client.waitForAny).toHaveBeenCalledWith(["sess_1"], expect.objectContaining({ since: 7 }))
  })

  it("sendPromptAndWait re-polls past a 'timeout' long-poll result instead of returning early", async () => {
    let calls = 0
    const client = fakeClient({
      waitForAny: vi.fn(async () => {
        calls++
        return calls < 3
          ? timedOutResult("sess_1")
          : { sessionId: "sess_1", event: "turn-end" as const }
      }),
    })
    const host = makeDaemonAgentSessionHost(client)
    await host.sendPromptAndWait("sess_1", "do the thing")
    expect(client.waitForAny).toHaveBeenCalledTimes(3)
  })

  it("does not resolve after a single timed-out poll — only after a real match (regression: a real daemon timeout carries no `event` field at all, so checking `event !== \"timeout\"` resolves immediately on the first poll instead of continuing to poll)", async () => {
    const client = fakeClient({
      waitForAny: vi
        .fn()
        .mockResolvedValueOnce(timedOutResult("sess_1"))
        .mockResolvedValueOnce({ sessionId: "sess_1", event: "turn-end" as const }),
    })
    const host = makeDaemonAgentSessionHost(client)

    await host.sendPromptAndWait("sess_1", "do the thing")

    expect(client.waitForAny).toHaveBeenCalledTimes(2)
  })

  it("close closes the underlying client", async () => {
    const client = fakeClient()
    const host = makeDaemonAgentSessionHost(client)
    await host.close()
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it("usage forwards session_usage when the client has it, and is absent otherwise", async () => {
    const snapshot = { sessionId: "sess_1", model: "claude-sonnet-4-6", costUsd: 0.42, tokensIn: 10, tokensOut: 5, source: "adapter" as const }
    const withUsage = fakeClient({ usage: vi.fn(async () => snapshot) })
    const host = makeDaemonAgentSessionHost(withUsage)
    expect(host.usage).toBeTypeOf("function")
    await expect(host.usage!("sess_1")).resolves.toEqual(snapshot)
    expect(withUsage.usage).toHaveBeenCalledWith("sess_1")

    const without = makeDaemonAgentSessionHost(fakeClient())
    expect(without.usage).toBeUndefined()
  })
})
