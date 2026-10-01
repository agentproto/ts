/**
 * `promptDeviceSession` (BOOTSTRAP P7a / issue #1637) — the controller-id →
 * host-id resolution rules: (a) exact host id first (current behavior),
 * (b) one mapping retry through the local registry when (a) fails with the
 * `no session` shape, and the actionable error when both fail.
 */

import { describe, it, expect, vi } from "vitest"
import {
  promptDeviceSession,
  promptHostSession,
  resolveDevicePromptMapping,
  isNoSessionPromptFailure,
} from "../device-registry.js"
import type {
  ForwardHttpRequest,
  ForwardHttpResponse,
  HostRegistry,
  HostRecord,
} from "../host-registry.js"

function jsonRes(status: number, body: unknown): ForwardHttpResponse {
  return { status, headers: {}, body: new Uint8Array(Buffer.from(JSON.stringify(body))) }
}

function fakeHosts(
  forwards: Array<(req: ForwardHttpRequest) => ForwardHttpResponse>,
): { hosts: HostRegistry; dials: ForwardHttpRequest[] } {
  const dials: ForwardHttpRequest[] = []
  let i = 0
  const hosts = {
    list: async () =>
      [
        {
          fingerprint: "fp1",
          name: "win-host",
          daemonX25519Pub: "pk",
          daemonEd25519Pub: "sk",
          rendezvousUrl: "wss://rdv.example/v1",
          pairRoot: "pr",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeen: "2026-01-02T00:00:00.000Z",
        },
      ] as HostRecord[],
    forwardHttp: async (_idOrName: string, req: ForwardHttpRequest) => {
      dials.push(req)
      const responder = forwards[Math.min(i, forwards.length - 1)]!
      i++
      return responder(req)
    },
  } as unknown as HostRegistry
  return { hosts, dials }
}

function ctrlSessions(
  map: Map<string, { id: string; hostSessionId?: string; hostFingerprint?: string }>,
) {
  return {
    findByIdOrName: (q: string) => map.get(q),
  }
}

describe("promptDeviceSession (P7a id resolution)", () => {
  describe("isNoSessionPromptFailure", () => {
    it("recognises the enqueuePrompt 404 envelope and nothing else", () => {
      const noSession = { ok: false, status: 404, message: 'enqueuePrompt: no session "sess_canary_c"' }
      const gate = { ok: false, status: 403, message: "not opted in" }
      const ok = { ok: true }
      const messageOnly = { ok: false, message: 'no session "sess_canary_c" known here' }
      expect(isNoSessionPromptFailure(noSession as never)).toBe(true)
      expect(isNoSessionPromptFailure(messageOnly as never)).toBe(true)
      expect(isNoSessionPromptFailure(gate as never)).toBe(false)
      expect(isNoSessionPromptFailure(ok as never)).toBe(false)
    })
  })

  describe("resolveDevicePromptMapping", () => {
    it("maps only a controller descriptor carrying BOTH identity fields on the SAME device", async () => {
      const { hosts } = fakeHosts([])
      const sessions = ctrlSessions(
        new Map([
          ["sess_ctrl", { id: "sess_ctrl", hostSessionId: "sess_host", hostFingerprint: "fp1" }],
          ["sess_dot", { id: "sess_dot", hostSessionId: "sess_host2", hostFingerprint: "win-host" }],
          ["sess_fpo", { id: "sess_fpo", hostSessionId: "sess_host3", hostFingerprint: "gone-device" }],
        ]),
      )
      expect(await resolveDevicePromptMapping(sessions, hosts, "sess_ctrl", "fp1")).toEqual({
        kind: "controller",
        hostSessionId: "sess_host",
      })
      // name-form fingerprint matched against a host-record name target
      expect(await resolveDevicePromptMapping(sessions, hosts, "sess_dot", "win-host")).toEqual({
        kind: "controller",
        hostSessionId: "sess_host2",
      })
      // a mapping onto a DIFFERENT device never applies
      expect(await resolveDevicePromptMapping(sessions, hosts, "sess_fpo", "fp1")).toEqual({ kind: "none" })
      expect(await resolveDevicePromptMapping(sessions, hosts, "sess_26", "fp1")).toEqual({ kind: "none" })
    })
  })

  it("(a) an exact host id is delivered directly, with no registry consult", async () => {
    const { hosts, dials } = fakeHosts([() => jsonRes(202, { ok: true })])
    const res = await promptDeviceSession(hosts, undefined, "fp1", "sess_host", { prompt: "hi" })
    expect(res).toMatchObject({ ok: true })
    expect(dials).toHaveLength(1)
  })

  it("(b) a controller id 404s once, then the mapping retry delivers to the host id", async () => {
    const { hosts, dials } = fakeHosts([
      () => jsonRes(404, { message: 'enqueuePrompt: no session "sess_canary_c"' }),
      () => jsonRes(202, { ok: true }),
    ])
    const sessions = ctrlSessions(
      new Map([["sess_canary_c", { id: "sess_canary_c", hostSessionId: "sess_host", hostFingerprint: "fp1" }]]),
    )
    const res = await promptDeviceSession(hosts, sessions, "fp1", "sess_canary_c", { prompt: "keep going" })
    expect(res).toMatchObject({ ok: true })
    expect(dials).toHaveLength(2)
    expect(dials[0]!.path).toBe("/device-prompt/sess_canary_c?wait=false")
    expect(dials[1]!.path).toBe("/device-prompt/sess_host?wait=false")
  })

  it("both failing reads an actionable error naming host and mapping", async () => {
    const { hosts } = fakeHosts([
      () => jsonRes(404, { message: 'enqueuePrompt: no session "sess_canary_c"' }),
      () => jsonRes(404, { message: 'enqueuePrompt: no session "sess_host"' }),
    ])
    const sessions = ctrlSessions(
      new Map([["sess_canary_c", { id: "sess_canary_c", hostSessionId: "sess_host", hostFingerprint: "fp1" }]]),
    )
    const res = await promptDeviceSession(hosts, sessions, "fp1", "sess_canary_c", { prompt: "hi" })
    expect(res.ok).toBe(false)
    expect(res.message).toBe('no session "sess_canary_c" on host fp1 and no controller descriptor maps it')
  })

  it("a pairing-gate refusal is never masked by a mapping retry", async () => {
    const { hosts, dials } = fakeHosts([() => jsonRes(403, { error: "spawn_disabled", message: "not opted in" })])
    const sessions = ctrlSessions(
      new Map([["sess_canary_c", { id: "sess_canary_c", hostSessionId: "sess_host", hostFingerprint: "fp1" }]]),
    )
    const res = await promptDeviceSession(hosts, sessions, "fp1", "sess_canary_c", { prompt: "hi" })
    expect(res).toMatchObject({ ok: false, status: 403, message: "not opted in" })
    expect(dials).toHaveLength(1)
  })

  it("promptHostSession's original contract is unchanged (no sessions wired)", async () => {
    const { hosts, dials } = fakeHosts([() => jsonRes(202, { ok: true })])
    const res = await promptHostSession(hosts, "fp1", "sess_host", { prompt: "hi" })
    expect(res).toMatchObject({ ok: true })
    expect(dials).toHaveLength(1)
  })
})
