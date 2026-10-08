/**
 * `kind: "agent"` transport retry: a session that dies under its first turn
 * (killed, ACP connection closed) is re-spawned with the same prompt; a step
 * whose turn completed, or that failed on content, never is. Regression for
 * wfrun_e6b00b3f (2026-10-08): one "ACP connection closed" 6 s into
 * `apply-fact-fixes` failed a 20-step editorial-desk run.
 */

import { describe, it, expect, vi } from "vitest"
import { z } from "zod"
import {
  runWorkflow,
  AgentSessionLostError,
  AgentSpawnError,
  DEFAULT_AGENT_TRANSPORT_RETRY,
  isAgentTransportFailure,
  type AgentRetryEvent,
  type AgentSessionHost,
  type AgentStep,
  type RuntimeWorkflow,
} from "../index.js"

/** A host whose sessions are numbered `sess_1`, `sess_2`, … in spawn order;
 *  `turn(sessionId, prompt, n)` decides each prompt's fate (n = 1-based
 *  prompt count for that session). */
function retryHost(
  turn: (sessionId: string, prompt: string, n: number) => void | Promise<void> = () => {},
  extra: Partial<AgentSessionHost> = {},
) {
  let spawned = 0
  const promptsBySession = new Map<string, string[]>()
  const host = {
    spawn: vi.fn(async () => `sess_${++spawned}`),
    sendPromptAndWait: vi.fn(async (sessionId: string, prompt: string) => {
      const list = promptsBySession.get(sessionId) ?? []
      list.push(prompt)
      promptsBySession.set(sessionId, list)
      await turn(sessionId, prompt, list.length)
    }),
    resolveByLabel: vi.fn(() => undefined as string | undefined),
    releaseSession: vi.fn(async () => {}),
    ...extra,
  }
  return { host, promptsBySession }
}

function lost(sessionId: string): AgentSessionLostError {
  return new AgentSessionLostError(sessionId, `session ${sessionId} ended with status 'killed'`)
}

function oneStep(step: Partial<AgentStep> = {}): RuntimeWorkflow {
  return {
    id: "retry-wf",
    steps: [{ kind: "agent", id: "apply", adapter: "mock", prompt: () => "fix the facts", ...step } as AgentStep],
  }
}

/** Explicit zero-delay policy, so tests don't sit through the default 1 s. */
const fast = (maxAttempts: number) => ({ maxAttempts, backoff: "fixed" as const, initialMs: 0 })

describe("agent step transport retry", () => {
  it("default policy: one retry after a session lost mid-turn — fresh session, same prompt", async () => {
    vi.useFakeTimers()
    try {
      const { host, promptsBySession } = retryHost((sid) => {
        if (sid === "sess_1") throw lost(sid)
      })
      const retries: AgentRetryEvent[] = []
      const run = runWorkflow({ workflow: oneStep(), agents: host, onAgentRetry: (ev) => retries.push(ev) })
      await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_TRANSPORT_RETRY.initialMs!)
      const { output } = await run
      expect(output).toEqual({ sessionId: "sess_2" })
      expect(host.spawn).toHaveBeenCalledTimes(2)
      expect(promptsBySession.get("sess_1")).toEqual(["fix the facts"])
      expect(promptsBySession.get("sess_2")).toEqual(["fix the facts"])
      expect(retries).toEqual([
        {
          stepId: "apply",
          attempt: 2,
          maxAttempts: 2,
          error: "session sess_1 ended with status 'killed'",
          sessionId: "sess_1",
          delayMs: 1_000,
        },
      ])
      // The dead session is released at once, not left for scope end.
      expect(host.releaseSession).toHaveBeenNthCalledWith(1, "sess_1")
    } finally {
      vi.useRealTimers()
    }
  })

  it("default policy gives up after the second loss with the transport error", async () => {
    const { host } = retryHost((sid) => {
      throw lost(sid)
    })
    await expect(runWorkflow({ workflow: oneStep({ retry: fast(2) }), agents: host })).rejects.toBeInstanceOf(
      AgentSessionLostError,
    )
    expect(host.spawn).toHaveBeenCalledTimes(2)
  })

  it("never retries a content failure (empty / errored turn)", async () => {
    const { host } = retryHost(() => {
      throw new Error("session sess_1 ended its turn with reason 'error'")
    })
    await expect(runWorkflow({ workflow: oneStep({ retry: fast(3) }), agents: host })).rejects.toThrow(
      /reason 'error'/,
    )
    expect(host.spawn).toHaveBeenCalledTimes(1)
  })

  it("never retries a step whose turn completed — a loss during an outputSchema re-prompt fails the step", async () => {
    const { host } = retryHost(
      (sid, _prompt, n) => {
        if (n === 2) throw lost(sid)
      },
      { readFinalMessage: vi.fn(async () => "not json") },
    )
    const wf = oneStep({ retry: fast(3), outputSchema: z.object({ ok: z.boolean() }) })
    await expect(runWorkflow({ workflow: wf, agents: host })).rejects.toBeInstanceOf(AgentSessionLostError)
    expect(host.spawn).toHaveBeenCalledTimes(1)
  })

  it("never retries a loss after an input-request resume (the first turn had ended)", async () => {
    let asked = false
    const { host } = retryHost(
      (sid, _prompt, n) => {
        if (n === 2) throw lost(sid)
      },
      {
        takeInputRequest: vi.fn(() => {
          if (asked) return undefined
          asked = true
          return { prompt: "which tone?" }
        }),
      },
    )
    await expect(
      runWorkflow({ workflow: oneStep({ retry: fast(3) }), agents: host, onInputRequired: async () => ({ tone: "dry" }) }),
    ).rejects.toBeInstanceOf(AgentSessionLostError)
    expect(host.spawn).toHaveBeenCalledTimes(1)
  })

  it("a spawn failure is NOT retried by the default policy (the fan-out breaker wants it at once)", async () => {
    const { host } = retryHost()
    host.spawn.mockRejectedValue(new Error("adapter 'mock' not installed"))
    await expect(runWorkflow({ workflow: oneStep(), agents: host })).rejects.toBeInstanceOf(AgentSpawnError)
    expect(host.spawn).toHaveBeenCalledTimes(1)
  })

  it("a declared retry also covers spawn failures", async () => {
    const { host } = retryHost()
    host.spawn
      .mockRejectedValueOnce(new Error("EAGAIN"))
      .mockRejectedValueOnce(new Error("EAGAIN"))
      .mockResolvedValueOnce("sess_ok")
    const retries: AgentRetryEvent[] = []
    const { output } = await runWorkflow({
      workflow: oneStep({ retry: fast(3) }),
      agents: host,
      onAgentRetry: (ev) => retries.push(ev),
    })
    expect(output).toEqual({ sessionId: "sess_ok" })
    expect(retries.map((r) => [r.attempt, r.sessionId])).toEqual([
      [2, undefined],
      [3, undefined],
    ])
  })

  it("maxAttempts: 1 disables the retry", async () => {
    const { host } = retryHost((sid) => {
      throw lost(sid)
    })
    await expect(runWorkflow({ workflow: oneStep({ retry: fast(1) }), agents: host })).rejects.toBeInstanceOf(
      AgentSessionLostError,
    )
    expect(host.spawn).toHaveBeenCalledTimes(1)
  })

  it("a sessionRef reuse is never retried (no fresh session to fall back to)", async () => {
    const { host } = retryHost((sid) => {
      throw lost(sid)
    })
    host.resolveByLabel.mockReturnValue("sess_prior")
    const wf: RuntimeWorkflow = {
      id: "reuse",
      steps: [{ kind: "agent", id: "again", sessionRef: "apply", prompt: () => "more", retry: fast(3) }],
    }
    await expect(runWorkflow({ workflow: wf, agents: host })).rejects.toBeInstanceOf(AgentSessionLostError)
    expect(host.sendPromptAndWait).toHaveBeenCalledTimes(1)
    expect(host.spawn).not.toHaveBeenCalled()
  })

  it("a cancelled run is never retried", async () => {
    const ac = new AbortController()
    const { host } = retryHost((sid) => {
      ac.abort()
      throw lost(sid)
    })
    await expect(
      runWorkflow({ workflow: oneStep({ retry: fast(3) }), agents: host, signal: ac.signal }),
    ).rejects.toBeInstanceOf(AgentSessionLostError)
    expect(host.spawn).toHaveBeenCalledTimes(1)
  })

  it("exponential backoff doubles the reported delay", async () => {
    vi.useFakeTimers()
    try {
      const { host } = retryHost((sid) => {
        if (sid !== "sess_3") throw lost(sid)
      })
      const delays: number[] = []
      const run = runWorkflow({
        workflow: oneStep({ retry: { maxAttempts: 3, backoff: "exponential", initialMs: 10 } }),
        agents: host,
        onAgentRetry: (ev) => delays.push(ev.delayMs),
      })
      await vi.advanceTimersByTimeAsync(30)
      await expect(run).resolves.toMatchObject({ output: { sessionId: "sess_3" } })
      expect(delays).toEqual([10, 20])
    } finally {
      vi.useRealTimers()
    }
  })

  it("classifies by the `transport: true` marker, not class identity (a host's own copy of the package)", async () => {
    const { host } = retryHost((sid) => {
      if (sid === "sess_1") throw Object.assign(new Error("ACP connection closed"), { transport: true })
    })
    const { output } = await runWorkflow({ workflow: oneStep({ retry: fast(2) }), agents: host })
    expect(output).toEqual({ sessionId: "sess_2" })
    expect(isAgentTransportFailure(new AgentSpawnError("s", new Error("x")))).toBe(true)
    expect(isAgentTransportFailure(new Error("plain"))).toBe(false)
  })

  it("banks the lost session's cost — the retry still honours maxTotalCostUsd", async () => {
    const { host } = retryHost(
      (sid) => {
        if (sid === "sess_1") throw lost(sid)
      },
      { readCostUsd: vi.fn(async (sid: string) => (sid === "sess_1" ? 5 : 0)) },
    )
    await expect(
      runWorkflow({ workflow: oneStep({ retry: fast(2) }), agents: host, maxTotalCostUsd: 1 }),
    ).rejects.toThrow(/budget_exceeded/)
    expect(host.spawn).toHaveBeenCalledTimes(1)
  })

  it("reports a fan-out item's retry under its indexed step key", async () => {
    const { host } = retryHost((sid) => {
      if (sid === "sess_1") throw lost(sid)
    })
    const keys: string[] = []
    const wf: RuntimeWorkflow = {
      id: "fan",
      steps: [
        {
          kind: "map",
          id: "fan",
          over: () => ["only"],
          body: () => ({ kind: "agent", id: "item", adapter: "mock", prompt: () => "go", retry: fast(2) }),
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host, onAgentRetry: (ev) => keys.push(ev.stepId) })
    expect(keys).toEqual(["item[0]"])
  })
})
