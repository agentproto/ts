import { describe, it, expect, vi } from "vitest"
import type { DaemonClient } from "../agent-session-host.js"
import { makeDaemonAgentSessionHost } from "../agent-session-host.js"

function fakeClient(overrides: Partial<DaemonClient> = {}): DaemonClient {
  return {
    start: vi.fn(async () => ({ id: "sess_1", status: "running", startedAt: "now" })),
    prompt: vi.fn(async () => {}),
    waitForAny: vi.fn(async () => ({ sessionId: "sess_1", event: "turn-end" as const })),
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

  it("sendPromptAndWait sends the prompt then waits for the turn to settle", async () => {
    const order: string[] = []
    const client = fakeClient({
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
    // the wait subscribes before the prompt is sent (avoids a race where an
    // extremely fast turn settles before the wait call starts listening)
    expect(order).toEqual(["wait-settled", "prompt"])
    expect(client.prompt).toHaveBeenCalledTimes(1)
    expect(client.waitForAny).toHaveBeenCalledTimes(1)
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
})
