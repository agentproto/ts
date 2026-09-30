/**
 * Unit tests for `promptHostSession` (BOOTSTRAP P4 item 1) — the write
 * counterpart of `device_sessions`. Pure stub-based: a fake `HostRegistry`
 * records every forwarded request and scripts the host's responses, so the
 * enqueue path, the `wait` polling loop, and every refusal are exercised
 * hermetically (injectable sleep, no real timers beyond the test's own).
 */

import { describe, it, expect, vi } from "vitest"
import { promptHostSession } from "../device-registry.js"
import type { ForwardHttpRequest, ForwardHttpResponse, HostRegistry } from "../host-registry.js"

interface Call {
  method: string
  path: string
  body?: string
}

/** A fake host registry whose `forwardHttp` is scripted: each call runs the
 *  next responder (or the last one, repeated). Responders see the parsed
 *  forwarded request. */
function fakeHosts(responders: Array<(call: Call) => ForwardHttpResponse>): {
  hosts: HostRegistry
  calls: Call[]
} {
  const calls: Call[] = []
  let i = 0
  const hosts = {
    forwardHttp: vi.fn(async (_id: string, req: ForwardHttpRequest) => {
      const call: Call = {
        method: req.method,
        path: req.path,
        ...(req.body ? { body: Buffer.from(req.body).toString("utf8") } : {}),
      }
      calls.push(call)
      const responder = responders[Math.min(i, responders.length - 1)]!
      i++
      return responder(call)
    }),
  } as unknown as HostRegistry
  return { hosts, calls }
}

function jsonRes(status: number, body: unknown): ForwardHttpResponse {
  return { status, headers: {}, body: new Uint8Array(Buffer.from(JSON.stringify(body))) }
}

const noSleep = async (): Promise<void> => {}

describe("promptHostSession", () => {
  it("refuses when no HostRegistry was wired", async () => {
    await expect(
      promptHostSession(undefined, "h1", "s1", { prompt: "hi", sleep: noSleep }),
    ).rejects.toThrow(/no host registry wired/)
  })

  it("refuses an ill-formed prompt without forwarding anything", async () => {
    const { hosts, calls } = fakeHosts([])
    for (const bad of ["", [], [null], null]) {
      const result = await promptHostSession(hosts, "h1", "s1", { prompt: bad, sleep: noSleep })
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/prompt/)
    }
    expect(calls).toHaveLength(0)
  })

  it("fire-and-forget: forwards POST /device-prompt/:id?wait=false with queue:true, relays the 202 body", async () => {
    const { hosts, calls } = fakeHosts([
      () => jsonRes(202, { ok: true, id: "s1", queued: true }),
    ])
    const result = await promptHostSession(hosts, "office-mac", "s1", {
      prompt: "go check X",
      sleep: noSleep,
    })
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.path).toBe("/device-prompt/s1?wait=false")
    expect(JSON.parse(calls[0]!.body!)).toEqual({ prompt: "go check X", queue: true })
  })

  it("fire-and-forget: a queued enqueue surfaces pending/queueId/queuePosition", async () => {
    const { hosts } = fakeHosts([
      () => jsonRes(202, { ok: true, id: "s1", queued: true, pending: true, queueId: "q_abc", queuePosition: 3 }),
    ])
    const result = await promptHostSession(hosts, "h1", "s1", { prompt: "hi", sleep: noSleep })
    expect(result).toEqual({ ok: true, pending: true, queueId: "q_abc", queuePosition: 3 })
  })

  it("fire-and-forget: an interrupt/force request rides in the enqueue body", async () => {
    const { hosts, calls } = fakeHosts([() => jsonRes(202, { ok: true, id: "s1", queued: true })])
    await promptHostSession(hosts, "h1", "s1", { prompt: "hi", interrupt: true, force: true, sleep: noSleep })
    expect(JSON.parse(calls[0]!.body!)).toEqual({ prompt: "hi", queue: true, interrupt: true, force: true })
  })

  it("surfaces the host's non-2xx enqueue rejection verbatim", async () => {
    const { hosts, calls } = fakeHosts([
      () => jsonRes(403, { error: "spawn_disabled", message: "this host has not opted in" }),
    ])
    const result = await promptHostSession(hosts, "h1", "s1", { prompt: "hi", sleep: noSleep })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
    expect(result.message).toMatch(/has not opted in/)
    expect(calls).toHaveLength(1)
  })

  it("wait: polls the host's descriptor until the turn drains, then reports waitedMs", async () => {
    const { hosts, calls } = fakeHosts([
      () => jsonRes(202, { ok: true, id: "s1", queued: true }),
      () =>
        jsonRes(200, {
          id: "s1",
          alive: true,
          busy: true,
          promptQueue: [{ id: "q_1" }],
        }),
      () => jsonRes(200, { id: "s1", alive: true, busy: false, promptQueue: [] }),
    ])
    const result = await promptHostSession(hosts, "h1", "s1", { prompt: "hi", wait: true, sleep: noSleep })
    expect(result).toMatchObject({ ok: true })
    expect(typeof result.waitedMs).toBe("number")
    expect(calls).toHaveLength(3)
    expect(calls[1]!.method).toBe("GET")
    expect(calls[1]!.path).toBe("/sessions/s1")
  })

  it("wait: a session that died while waiting is a failure, not a hang", async () => {
    const { hosts } = fakeHosts([
      () => jsonRes(202, { ok: true, id: "s1", queued: true }),
      () => jsonRes(200, { id: "s1", alive: false }),
    ])
    const result = await promptHostSession(hosts, "h1", "s1", { prompt: "hi", wait: true, sleep: noSleep })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/ended while waiting/)
  })

  it("wait: a session gone from the host surfaces 404", async () => {
    const { hosts } = fakeHosts([
      () => jsonRes(202, { ok: true, id: "s1", queued: true }),
      () => jsonRes(404, { error: "no session" }),
    ])
    const result = await promptHostSession(hosts, "h1", "s1", { prompt: "hi", wait: true, sleep: noSleep })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
  })

  it("wait: maxWaitMs gives up with a timeout message instead of waiting forever", async () => {
    const { hosts, calls } = fakeHosts([
      () => jsonRes(202, { ok: true, id: "s1", queued: true }),
      () => jsonRes(200, { id: "s1", alive: true, busy: true, promptQueue: [] }),
    ])
    const result = await promptHostSession(hosts, "h1", "s1", {
      prompt: "hi",
      wait: true,
      maxWaitMs: 0.0001,
      sleep: noSleep,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/timed out/)
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it("wait: the descriptor poll failing mid-wait surfaces the forward error", async () => {
    const { hosts } = fakeHosts([
      () => jsonRes(202, { ok: true, id: "s1", queued: true }),
    ])
    // Make the SECOND call (the descriptor poll) throw like an unreachable host.
    const throwing = hosts.forwardHttp as ReturnType<typeof vi.fn>
    throwing.mockImplementationOnce(async () => jsonRes(202, { ok: true, id: "s1", queued: true }))
    throwing.mockImplementation(async () => {
      throw new Error("could not reach host h1")
    })
    const result = await promptHostSession(hosts, "h1", "s1", { prompt: "hi", wait: true, sleep: noSleep })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/could not reach host/)
  })
})
