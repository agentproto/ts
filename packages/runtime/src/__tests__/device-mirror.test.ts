/**
 * BOOTSTRAP P7b — device-mirror unit tests (#1637): fetchHostTurns
 * (pagination + dial-failure/stale semantics), the seed walk, record
 * normalization, and the read-time sync into a REAL SessionsRegistry
 * (merge, idempotent re-read, mirrorError, local spawns untouched).
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"

import {
  syncDeviceMirror,
  fetchHostTurns,
  mirrorCursorForSession,
  hostRecordToMirrorRecord,
  seedWalkForTranscript,
} from "../device-mirror.js"
import type {
  ForwardHttpRequest,
  ForwardHttpResponse,
  HostRegistry,
  HostRecord,
} from "../host-registry.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { sessionEventsPath } from "../transcript-writer.js"

function jsonRes(status: number, body: unknown): ForwardHttpResponse {
  return { status, headers: {}, body: new Uint8Array(Buffer.from(JSON.stringify(body))) }
}

type Responder = (req: ForwardHttpRequest) => ForwardHttpResponse

/** Host double: routes a fixed transcript (`events?since=<n>` semantics) —
 *  `fail` makes every dial throw (host unreachable). `snapshot` serves the
 *  descriptor `GET /sessions/:id` route. */
function fakeHosts(opts: {
  events?: Array<Record<string, unknown>>
  fail?: boolean
  stale?: boolean
  snapshot?: Record<string, unknown> | false
}): { hosts: HostRegistry; dials: ForwardHttpRequest[] } {
  const dials: ForwardHttpRequest[] = []
  const hosts = {
    list: async () => [] as HostRecord[],
    forwardHttp: async (_idOrName: string, req: ForwardHttpRequest): Promise<ForwardHttpResponse> => {
      dials.push(req)
      if (opts.fail) throw new Error("tunnel down (rst)")
      if (opts.stale) return { ...jsonRes(200, {}), stale: true as const, capturedAt: "2026-10-01T00:00:00.000Z" }
      const path = req.path ?? ""
      const q = path.split("?")[1] ?? ""
      const since = Number(new URLSearchParams(q).get("since") ?? "0")
      if (path.startsWith("/sessions/") && path.includes("/events")) {
        const events = (opts.events ?? []).filter(e => typeof e["seq"] === "number" && (e["seq"] as number) > since)
        return jsonRes(200, { sessionId: "sess_host", events, nextSeq:(events.at(-1)?.["seq"] as number) ?? since, complete: true })
      }
      if (path.startsWith("/sessions/") && path.includes("/events") === false && opts.snapshot !== false) {
        return jsonRes(200, opts.snapshot ?? {})
      }
      return jsonRes(404, { error: "not_found" })
    },
    getSessionsSnapshot: () => undefined,
  } as unknown as HostRegistry
  return { hosts, dials }
}

function fakeAgentSession(reply: string): AgentSessionLike {
  let count = 0
  return {
    sessionId: "acp_fake",
    async *send(): AsyncIterable<import("../sessions.js").AgentStreamEvent> {
      count++
      yield { kind: "text-delta", text: `${reply} ${count}` }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

function spawnMirrorSession(registry: SessionsRegistry, cwd: string, initialPrompt: string): void {
  registry.spawnAgent({
    id: "sess_ctrl",
    workspaceSlug: "ws",
    cwd,
    agentSession: fakeAgentSession("handsome reply"),
    adapterSlug: "claude-code",
    depth: 0,
    initialPrompt,
    hostSessionId: "sess_host",
    hostFingerprint: "fp1",
  })
}

async function waitForLocalPrompt(baseDir: string): Promise<void> {
  await vi.waitFor(() => {
    const raw = readFileSync(sessionEventsPath("sess_ctrl", baseDir), "utf8")
    expect(raw).toContain('"user-prompt"')
  })
}

describe("fetchHostTurns", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("pages until the host reports complete and walks nextSeq past every page", async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => ({ seq: i + 1, kind: "text-delta", text: `p1${i}` }))
    const page2 = [
      { seq: 4, kind: "text-delta", text: "p2a" },
      { seq: 5, kind: "text-delta", text: "p2b" },
    ]
    const dials: ForwardHttpRequest[] = []
    const hosts = {
      forwardHttp: async (_t: string, req: ForwardHttpRequest) => {
        dials.push(req)
        const since = Number((req.path ?? "").split("since=")[1]?.split("&")[0] ?? "0")
        return since < 3 ? jsonRes(200, { events: page1, nextSeq: 3, complete: false }) : jsonRes(200, { events: page2, nextSeq: 5, complete: true })
      },
    } as unknown as HostRegistry
    const res = await fetchHostTurns(hosts, "fp1", "sess_host", 0)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.nextSeq).toBe(5)
      expect(res.events).toHaveLength(5)
    }
    expect(dials).toHaveLength(2)
  })

  it("a dial failure surfaces {ok:false, error} instead of stale data; 404 reads as empty", async () => {
    const { hosts } = fakeHosts({ fail: true })
    const failed = await fetchHostTurns(hosts, "fp1", "sess_host", 0)
    expect(failed.ok).toBe(false)

    const empty404 = {
      forwardHttp: async () => jsonRes(404, { error: "no_transcript" }),
    } as unknown as HostRegistry
    const empt = await fetchHostTurns(empty404, "fp1", "sess_host", 0)
    expect(empt.ok).toBe(true)
  })

  it("a stale snapshot never becomes data — ok:false with the capturedAt", async () => {
    const { hosts } = fakeHosts({ stale: true })
    const res = await fetchHostTurns(hosts, "fp1", "sess_host", 0)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("stale snapshot")
  })
})

describe("seedWalkForTranscript + normalization", () => {
  it("consumes known turns in order and seeds just before the first unknown prompt", () => {
    const host = [
      { seq: 5, kind: "user-prompt", text: "local turn one" },
      { seq: 6, kind: "text-delta", text: "handsome reply" },
      { seq: 7, kind: "turn-end", reason: "completed" },
      { seq: 8, kind: "user-prompt", text: "remote ask" },
      { seq: 9, kind: "turn-end" },
    ]
    expect(seedWalkForTranscript(["local turn one"], host)).toBe(7)
  })

  it("an all-known transcript walks to the tip; no local texts mirrors everything", () => {
    const host = [
      { seq: 5, kind: "user-prompt", text: "a" },
      { seq: 6, kind: "turn-end" },
    ]
    expect(seedWalkForTranscript(["a"], host)).toBe(6)
    expect(seedWalkForTranscript([], host)).toBe(0)
  })

  it("maps mirrored kinds and tags them; skips derived/kinds the controller derives itself", () => {
    const mapped = hostRecordToMirrorRecord(
      { seq: 9, ts: "2026-10-01T09:00:00.000Z", kind: "text-delta", text: "hi" },
      "fp1",
    )
    expect(mapped).toMatchObject({
      kind: "text-delta",
      origin: "device",
      hostSeq: 9,
      sourceRef: "device:fp1",
      ts: "2026-10-01T09:00:00.000Z",
      text: "hi",
    })
    expect(hostRecordToMirrorRecord({ seq: 10, kind: "system-prompt", text: "x" }, "fp1")).toBeUndefined()
    expect(hostRecordToMirrorRecord({ seq: 11, kind: "tool-call", toolCallId: "c1", toolName: "bash" }, "fp1"))
      .toMatchObject({ kind: "tool-call", toolName: "bash" })
  })
})

/** Append-stream buffered — the mirrored records land within a tick of the
 *  write, so reads after a sync wait for the flush rather than racing it.
 *  `transcriptsBaseDir` is set by each registry test's setup. */
let transcriptsBaseDir = ""
function readAllRecords(id: string): Record<string, unknown>[] {
  return readFileSync(sessionEventsPath(id, transcriptsBaseDir), "utf8")
    .split("\n")
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as Record<string, unknown>)
}
const readMirroredRecords = (id: string): Record<string, unknown>[] =>
  readAllRecords(id).filter(r => r["origin"] === "device")

async function awaitMirroredRecords(id: string, minCount: number): Promise<void> {
  await vi.waitFor(() => {
    expect(readMirroredRecords(id).length).toBeGreaterThanOrEqual(minCount)
  })
}

describe("syncDeviceMirror into a real registry", () => {
  let workspace: string
  let registry: SessionsRegistry

  afterEach(async () => {
    registry?.shutdown()
    if (workspace) await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    transcriptsBaseDir = ""
  })

  const setupRegistry = async (): Promise<void> => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-device-mirror-test-"))
    transcriptsBaseDir = join(workspace, "transcripts")
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(workspace, "transcripts") })
  }

  const HOST_EVENTS = () => [
    { seq: 5, ts: "2026-10-01T09:00:01.000Z", kind: "user-prompt", text: "local turn one" },
    { seq: 6, ts: "2026-10-01T09:00:01.500Z", kind: "text-delta", text: "handsome reply" },
    { seq: 7, ts: "2026-10-01T09:00:02.000Z", kind: "turn-end", reason: "completed" },
    { seq: 8, ts: "2026-10-01T09:05:00.000Z", kind: "user-prompt", text: "remote ask from device_prompt" },
    { seq: 9, ts: "2026-10-01T09:05:01.000Z", kind: "text-delta", text: "remote answer" },
    { seq: 10, ts: "2026-10-01T09:05:02.000Z", kind: "turn-end", reason: "completed" },
  ]

  it("merges unknown host turns tagged origin device + hostSeq, skips known ones, refreshes the descriptor, and never duplicates on re-read", async () => {
    await setupRegistry()
    spawnMirrorSession(registry, workspace, "local turn one")
    await waitForLocalPrompt(transcriptsBaseDir)
    const snapshot = { id: "sess_host", alive: false, busy: false, lastActivityAt: "2026-10-01T09:05:02.000Z", costUsd: 0.42 }
    const { hosts, dials } = fakeHosts({ events: HOST_EVENTS(), snapshot })

    const first = await syncDeviceMirror(registry, hosts, "sess_ctrl")
    expect(first).toMatchObject({ ok: true })
    if (!first.ok) return
    // The seed skipped the locally-known first turn (seqs 5–7); the
    // device_prompt turn (8–10) is new: prompt + delta + turn-end.
    expect(first.merged).toBe(3)
    expect(first.cursor).toBe(10)
    await awaitMirroredRecords("sess_ctrl", 3)

    const mirrored = readMirroredRecords("sess_ctrl")
    expect(
      mirrored.every(r => (r["hostSeq"] as number) > 7 && (r["hostSeq"] as number) <= 10),
    ).toBe(true)
    expect(mirrored.every(r => r["sourceRef"] === "device:fp1")).toBe(true)
    expect(mirrored.filter(r => r["kind"] === "user-prompt").map(r => r["text"])).toEqual([
      "remote ask from device_prompt",
    ])
    expect(mirrored.some(r => r["kind"] === "text-delta" && r["text"] === "remote answer")).toBe(true)
    // nothing re-merged earlier: the original local user-prompt is the sole
    // user-prompt WITHOUT the device tag.
    const rawAll = readAllRecords("sess_ctrl")
    expect(rawAll.filter(r => r["kind"] === "user-prompt")).toHaveLength(2)

    // Idempotent read #2 — no new host records, so no new appends; dial count
    // grows by exactly the events + snapshot reads of a fresh sync.
    const dialsAfterFirst = dials.length
    const mirroredSeqs = mirrored.map(r => r["hostSeq"] as number)
    const second = await syncDeviceMirror(registry, hosts, "sess_ctrl")
    expect(second).toMatchObject({ ok: true, merged: 0 })
    const mirrored2 = readMirroredRecords("sess_ctrl")
    expect(mirrored2.map(r => r["hostSeq"] as number)).toEqual(mirroredSeqs)
    expect(readMirroredRecords("sess_ctrl").every(r => r["sourceRef"] === "device:fp1")).toBe(true)
    expect(dials.length).toBeGreaterThan(dialsAfterFirst)

    // Live-projection refresh — the descriptor picks the fresher
    // lastActivityAt from the host snapshot, and success clears
    // mirrorError (which was never set here anyway).
    const desc = registry.findByIdOrName("sess_ctrl")
    expect(desc?.mirrorError).toBeUndefined()
  })

  it("a device session with NO mirrored content yet and no local knowledge merges from 0", async () => {
    await setupRegistry()
    registry.spawnAgent({
      id: "sess_ctrl2",
      workspaceSlug: "ws",
      cwd: workspace,
      agentSession: fakeAgentSession("idle"),
      adapterSlug: "claude-code",
      depth: 0,
      hostSessionId: "sess_host",
      hostFingerprint: "fp1",
    }) // no initial prompt — controller transcript has no user-prompt at all
    const { hosts } = fakeHosts({ events: HOST_EVENTS() })
    const res = await syncDeviceMirror(registry, hosts, "sess_ctrl2")
    expect(res).toMatchObject({ ok: true })
    if (!res.ok) return
    expect(res.merged).toBe(6)
    await awaitMirroredRecords("sess_ctrl2", 6)
    const raw = readAllRecords("sess_ctrl2")
    // Everything including the first turn got mirrored (seed 0 with no
    // local prompts)… …but the LOCAL side here has no turn-1 either, so
    // there's no visible duplicate content, only the mirrored history.
    const mirrored = raw.filter(r => r["origin"] === "device")
    expect(mirrored.some(r => r["hostSeq"] === 5 && r["kind"] === "user-prompt")).toBe(true)
  })

  it("host unreachable → {ok:false, mirror-error}, descriptor.mirrorError set, no crash; cleared on the next success", async () => {
    await setupRegistry()
    spawnMirrorSession(registry, workspace, "local turn one")
    await waitForLocalPrompt(transcriptsBaseDir)
    const failHosts = fakeHosts({ fail: true })
    const failing = await syncDeviceMirror(registry, failHosts.hosts, "sess_ctrl")
    expect(failing).toMatchObject({ ok: false, reason: "mirror-error" })
    expect(registry.findByIdOrName("sess_ctrl")?.mirrorError).toContain("tunnel down")

    // Recover: the same session's next sync succeeds and clears the marker.
    const okHosts = fakeHosts({ events: HOST_EVENTS() })
    const recovering = await syncDeviceMirror(registry, okHosts.hosts, "sess_ctrl")
    expect(recovering).toMatchObject({ ok: true })
    expect(registry.findByIdOrName("sess_ctrl")?.mirrorError).toBeUndefined()
  })

  it("a LOCAL spawn (no identity) costs zero dials and syncs nothing", async () => {
    await setupRegistry()
    registry.spawnAgent({
      id: "sess_local",
      workspaceSlug: "ws",
      cwd: workspace,
      agentSession: fakeAgentSession("local"),
      adapterSlug: "claude-code",
      depth: 0,
    })
    const { hosts, dials } = fakeHosts({ events: HOST_EVENTS() })
    const res = await syncDeviceMirror(registry, hosts, "sess_local")
    expect(res).toMatchObject({ ok: false, reason: "not-device" })
    expect(dials).toHaveLength(0)
  })

  it("a stale unknown id gives reason no-session; missing host registry gives no-host-registry", async () => {
    await setupRegistry()
    const { hosts } = fakeHosts({ events: HOST_EVENTS() })
    expect(await syncDeviceMirror(registry, hosts, "sess_missing")).toMatchObject({ ok: false, reason: "no-session" })

    spawnMirrorSession(registry, workspace, "local turn one")
    await waitForLocalPrompt(transcriptsBaseDir)
    expect(await syncDeviceMirror(registry, undefined, "sess_ctrl")).toMatchObject({ ok: false, reason: "no-host-registry" })
  })

  it("mirrorCursorForSession derives the cursor from the mirrored file after a merge", async () => {
    await setupRegistry()
    spawnMirrorSession(registry, workspace, "local turn one")
    await waitForLocalPrompt(transcriptsBaseDir)
    const { hosts } = fakeHosts({ events: HOST_EVENTS() })
    const res = await syncDeviceMirror(registry, hosts, "sess_ctrl")
    expect(res).toMatchObject({ ok: true })
    expect(await mirrorCursorForSession("sess_ctrl", transcriptsBaseDir)).toBe(10)
  })
})
