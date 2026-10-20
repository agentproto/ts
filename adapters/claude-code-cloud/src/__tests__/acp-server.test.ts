import { describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AgentSideConnection,
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
  PromptResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk"
import {
  ClaudeCloudAcpAgent,
  MAX_LIST_EVENTS_FAILURES,
  resultEventUpdates,
  resultStopReason,
  type CloudCliDeps,
  type CloudEventsClient,
} from "../acp-server.js"
import { CLOUD_SESSION_META_FILE_ENV, CLOUD_VENDOR_SLUG } from "../meta-file.js"
import type { CloudEventsPage, CloudSessionEvent } from "../sessions-api.js"
import type { CloudRepoSource } from "../repo-checkout.js"

// ── fixtures (FAKE ids/text, shaped like the 2026-10-14 observations) ──────
//
// The REAL events API (GET /v1/code/sessions/{id}/events):
//   - no `cursor` → the NEWEST page, newest first;
//   - `resume_cursor` (alias `next_cursor`, first page only) is the
//     sequence_num of the OLDEST event on the page;
//   - passing `?cursor=<n>` returns the next OLDER page — the cursor pages
//     BACKWARD in time, never forward.
// The FakeEvents backend below reproduces exactly that.

const VENDOR_ID = "session_01FakeId"
const VENDOR_URL = "https://claude.ai/code/session_01FakeId?tab=cloud"

/** One vendor event carrying a monotonic `sequence_num`. */
function event(
  seq: number,
  event_type: string,
  payload: unknown,
): CloudSessionEvent {
  return {
    created_at: new Date(Date.UTC(2026, 9, 14, 10, 0, seq)).toISOString(),
    event_id: `${event_type}-${seq}`,
    event_type,
    sequence_num: String(seq),
    source: "worker",
    payload,
  }
}

function assistantEvent(seq: number, text: string): CloudSessionEvent {
  return event(seq, "assistant", {
    type: "assistant",
    message: {
      id: `msg-${seq}`,
      type: "message",
      role: "assistant",
      model: "claude-fake",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    session_id: VENDOR_ID,
    parent_tool_use_id: null,
  })
}

function toolUseEvent(seq: number): CloudSessionEvent {
  return event(seq, "assistant", {
    type: "assistant",
    message: {
      id: `msg-${seq}`,
      type: "message",
      role: "assistant",
      model: "claude-fake",
      content: [
        {
          type: "tool_use",
          id: "toolu_fake_1",
          name: "Bash",
          input: { command: "ls -la" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    session_id: VENDOR_ID,
    parent_tool_use_id: null,
  })
}

function toolResultEvent(seq: number): CloudSessionEvent {
  return event(seq, "user", {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_fake_1",
          content: "file1\nfile2",
          is_error: false,
        },
      ],
    },
    session_id: VENDOR_ID,
    parent_tool_use_id: null,
  })
}

/** Follow-up-turn prompt echo: the vendor echoes the user's own prompt back
 *  as a `user` event carrying the prompt text (observed on turn 2+). */
function promptEchoEvent(seq: number, text: string): CloudSessionEvent {
  return event(seq, "user", {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    session_id: VENDOR_ID,
    parent_tool_use_id: null,
  })
}

/** A `user` event whose payload is NOT an SDK user message: projecting it
 *  through the generic mapper would emit a chunk. The echo guard keys off
 *  the EVENT type, so this must be dropped too. */
function userEventWithChunkPayload(seq: number, text: string): CloudSessionEvent {
  return event(seq, "user", {
    type: "assistant",
    message: {
      id: `msg-${seq}`,
      type: "message",
      role: "assistant",
      model: "claude-fake",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    session_id: VENDOR_ID,
    parent_tool_use_id: null,
  })
}

function resultEvent(
  seq: number,
  overrides: Record<string, unknown> = {},
): CloudSessionEvent {
  return event(seq, "result", {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    result: "all done",
    total_cost_usd: 0.17,
    duration_ms: 1234,
    duration_api_ms: 1000,
    usage: {
      input_tokens: 12,
      output_tokens: 34,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 5,
    },
    ...overrides,
  })
}

/**
 * A fake events backend with the REAL paging semantics: no cursor → newest
 * page, newest first; `cursor` → the next OLDER page (seq strictly below the
 * cursor). `resume_cursor` is the oldest seq on the page; `next_cursor` is
 * carried on the first (no-cursor) page only. Events are added at any time
 * (tests push while the observe loop is running).
 */
class FakeEvents {
  #entries: Array<{ seq: number; event: CloudSessionEvent }> = []
  readonly calls: Array<{ id: string; cursor?: string }> = []

  constructor(readonly pageSize = 50) {}

  push(...events: CloudSessionEvent[]): void {
    for (const e of events) this.#entries.push({ seq: Number(e.sequence_num), event: e })
  }

  api(): CloudEventsClient {
    return { listEvents: async (id, opts) => this.list(id, opts?.cursor) }
  }

  list(id: string, cursor?: string): CloudEventsPage {
    this.calls.push({ id, ...(cursor !== undefined ? { cursor } : {}) })
    const cutoff =
      cursor !== undefined ? Number(cursor) : Number.POSITIVE_INFINITY
    const older = [...this.#entries]
      .filter(e => e.seq < cutoff)
      .sort((a, b) => b.seq - a.seq)
    const page = older.slice(0, this.pageSize)
    const oldest = page.length > 0 ? page[page.length - 1]!.seq : undefined
    return {
      data: page.map(e => e.event),
      ...(oldest !== undefined ? { resume_cursor: String(oldest) } : {}),
      ...(cursor === undefined && oldest !== undefined
        ? { next_cursor: String(oldest) }
        : {}),
    }
  }
}

interface Harness {
  agent: ClaudeCloudAcpAgent
  conn: { sessionUpdate: ReturnType<typeof vi.fn> }
  start: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  sleep: ReturnType<typeof vi.fn>
  sleepDelays: number[]
  validateRepo: ReturnType<typeof vi.fn>
  materializeRepo: ReturnType<typeof vi.fn>
}

function harness(opts: {
  api: CloudEventsClient
  pollInitialMs?: number
  pollMaxMs?: number
  onSleep?: () => void
  repoSource?: CloudRepoSource
}): Harness {
  const conn = { sessionUpdate: vi.fn(async () => {}) }
  const start = vi.fn(async () => ({
    sessionId: VENDOR_ID,
    url: VENDOR_URL,
    title: "fake session",
  }))
  const send = vi.fn(async () => ({ stdout: "Sent to cloud session." }))
  const sleepDelays: number[] = []
  const sleep = vi.fn(async (ms: number) => {
    sleepDelays.push(ms)
    opts.onSleep?.()
  })
  const validateRepo = vi.fn(async () => {})
  const materializeRepo = vi.fn(async (source: CloudRepoSource) => source.dir)
  const cli: CloudCliDeps = {
    startCloudSession: start as unknown as CloudCliDeps["startCloudSession"],
    sendPrompt: send as unknown as CloudCliDeps["sendPrompt"],
  }
  const agent = new ClaudeCloudAcpAgent(conn as unknown as AgentSideConnection, {
    api: opts.api,
    cli,
    validateRepo: validateRepo as unknown as (cwd: string) => Promise<void>,
    // Never read the test process env: a declared source is opt-in per test.
    repoSource: opts.repoSource ?? null,
    materializeRepo,
    sleep: sleep as unknown as (ms: number) => Promise<void>,
    pollInitialMs: opts.pollInitialMs ?? 10,
    pollMaxMs: opts.pollMaxMs ?? 40,
  })
  return {
    agent,
    conn: conn as unknown as Harness["conn"],
    start,
    send,
    sleep,
    sleepDelays,
    validateRepo,
    materializeRepo,
  }
}

async function newSession(
  h: Harness,
  cwd = "/repo",
  mcpServers: unknown[] = [],
): Promise<string> {
  const res = await h.agent.newSession({
    cwd,
    mcpServers,
  } as unknown as NewSessionRequest)
  return res.sessionId
}

function prompt(sessionId: string, text: string): PromptRequest {
  return {
    sessionId,
    prompt: [{ type: "text", text }],
  } as unknown as PromptRequest
}

function updates(conn: Harness["conn"]): SessionNotification["update"][] {
  return conn.sessionUpdate.mock.calls.map(
    (c: unknown[]) => (c[0] as SessionNotification).update,
  )
}

/** Text carried by every agent_message_chunk, in projection order. */
function chunkTexts(conn: Harness["conn"]): string[] {
  return updates(conn)
    .filter(u => u.sessionUpdate === "agent_message_chunk")
    .map(u => {
      const c = (u as { content?: { text?: string } }).content
      return typeof c?.text === "string" ? c.text : ""
    })
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("ClaudeCloudAcpAgent", () => {
  it("session/new validates the repo source before creating anything", async () => {
    const events = new FakeEvents()
    const h = harness({ api: events.api() })
    h.validateRepo.mockRejectedValueOnce(new Error("working tree is dirty"))
    await expect(newSession(h)).rejects.toThrow(/working tree is dirty/)

    const h2 = harness({ api: events.api() })
    const id = await newSession(h2, "/repo")
    expect(h2.validateRepo).toHaveBeenCalledWith("/repo")
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("session/new with a declared repo runs from its fresh checkout, not the session cwd", async () => {
    const events = new FakeEvents()
    const repoSource = {
      url: "https://github.com/acme/repo",
      branch: "main",
      dir: "/cfg/repo",
    }
    const h = harness({
      api: events.api(),
      repoSource,
      onSleep: () => events.push(resultEvent(1)),
    })
    const sessionId = await newSession(h, "/host/workspace-without-clone")
    expect(h.materializeRepo).toHaveBeenCalledWith(repoSource)
    expect(h.validateRepo).toHaveBeenCalledWith("/cfg/repo")
    expect(h.validateRepo).not.toHaveBeenCalledWith("/host/workspace-without-clone")

    await h.agent.prompt(prompt(sessionId, "hello"))
    expect(h.start).toHaveBeenCalledWith("hello", { cwd: "/cfg/repo" })
  })

  it("session/new fails closed when the declared repo cannot be checked out", async () => {
    const h = harness({
      api: new FakeEvents().api(),
      repoSource: { url: "https://github.com/acme/repo", branch: "main", dir: "/cfg/repo" },
    })
    h.materializeRepo.mockRejectedValueOnce(new Error("could not clone"))
    await expect(newSession(h)).rejects.toThrow(/could not clone/)
    expect(h.validateRepo).not.toHaveBeenCalled()
  })

  it("session/new refuses mcpServers (AIP-66 §4)", async () => {
    const events = new FakeEvents()
    const h = harness({ api: events.api() })
    await expect(newSession(h, "/repo", [{ name: "x" }])).rejects.toThrow(
      /mcpServers is not supported/,
    )
    expect(h.validateRepo).not.toHaveBeenCalled()
  })

  it("first prompt starts a cloud session, surfaces the URL, and ends on the new result with usage", async () => {
    const events = new FakeEvents()
    // Turn-1 events arrive across polls: the first tick sees only the
    // assistant text; the rest are written while the loop is sleeping.
    events.push(assistantEvent(1, "Working on it"))
    const h = harness({
      api: events.api(),
      pollInitialMs: 10,
      onSleep: () => events.push(toolUseEvent(2), toolResultEvent(3), resultEvent(4)),
    })
    const sessionId = await newSession(h)
    const res: PromptResponse = await h.agent.prompt(prompt(sessionId, "hello"))

    expect(res.stopReason).toBe("end_turn")
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.start).toHaveBeenCalledWith("hello", { cwd: "/repo" })
    expect(h.send).not.toHaveBeenCalled()

    const projected = updates(h.conn)
    // Info message with the session URL, first among the updates.
    expect(projected[0]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: expect.stringContaining(VENDOR_URL) },
    })
    // Assistant text → agent_message_chunk; tool_use → tool_call;
    // tool_result → tool_call_update; result → usage_update.
    expect(
      projected.some(
        u =>
          u.sessionUpdate === "agent_message_chunk" &&
          JSON.stringify(u).includes("Working on it"),
      ),
    ).toBe(true)
    expect(projected.some(u => u.sessionUpdate === "tool_call")).toBe(true)
    expect(
      projected.some(
        u => u.sessionUpdate === "tool_call_update" && u.status === "completed",
      ),
    ).toBe(true)
    const usage = projected.find(u => u.sessionUpdate === "usage_update")
    expect(usage).toMatchObject({
      cost: { amount: 0.17, currency: "USD" },
      tokensIn: 17, // input 12 + cache_read 5 + cache_creation 0
      tokensOut: 34,
    })
    // Every poll asks for the NEWEST page (no cursor) — progress is tracked
    // by sequence_num, not by a forward cursor.
    expect(events.calls.every(c => c.cursor === undefined)).toBe(true)
  })

  it("projects events in ASCENDING sequence_num order (the API serves them newest-first)", async () => {
    const events = new FakeEvents()
    // Pushed out of order; the backend always serves them newest-first.
    events.push(
      assistantEvent(3, "third"),
      assistantEvent(1, "first"),
      assistantEvent(2, "second"),
      resultEvent(4),
    )
    const h = harness({ api: events.api() })
    const sessionId = await newSession(h)
    const res = await h.agent.prompt(prompt(sessionId, "hi"))

    expect(res.stopReason).toBe("end_turn")
    const texts = chunkTexts(h.conn).filter(t =>
      ["first", "second", "third"].includes(t),
    )
    expect(texts).toEqual(["first", "second", "third"])
  })

  it("ends the turn on a new result spread across two pages written while polling", async () => {
    // pageSize 2 forces a multi-page catch-up within one tick.
    const events = new FakeEvents(2)
    events.push(assistantEvent(1, "start"))
    let wrote = false
    const h = harness({
      api: events.api(),
      onSleep: () => {
        if (wrote) return
        wrote = true
        events.push(assistantEvent(2, "middle"), assistantEvent(3, "late"), resultEvent(4))
      },
    })
    const sessionId = await newSession(h)
    const res = await h.agent.prompt(prompt(sessionId, "hi"))

    expect(res.stopReason).toBe("end_turn")
    // The second tick had to page BACKWARD (a cursor call) to reach its
    // lastSeq boundary.
    expect(events.calls.some(c => c.cursor !== undefined)).toBe(true)
    const texts = chunkTexts(h.conn)
    expect(texts).toContain("middle")
    expect(texts).toContain("late")
    expect(
      updates(h.conn).filter(u => u.sessionUpdate === "usage_update"),
    ).toHaveLength(1)
  })

  it("projects EVERY event when more than one page (50) is written between two ticks, paging backward", async () => {
    const events = new FakeEvents() // pageSize 50
    events.push(assistantEvent(1, "seed"))
    let wrote = false
    const h = harness({
      api: events.api(),
      onSleep: () => {
        if (wrote) return
        wrote = true
        // 60 new events (seq 2..61): more than one page.
        for (let seq = 2; seq <= 60; seq += 1) events.push(assistantEvent(seq, `m${seq}`))
        events.push(resultEvent(61))
      },
    })
    const sessionId = await newSession(h)
    const res = await h.agent.prompt(prompt(sessionId, "hi"))

    expect(res.stopReason).toBe("end_turn")
    const texts = chunkTexts(h.conn)
    // All 59 assistant events between the seed and the result projected.
    expect(texts).toContain("m2")
    expect(texts).toContain("m60")
    expect(texts.filter(t => /^m\d+$/.test(t))).toHaveLength(59)
    // The catch-up paged BACKWARD past the first (newest) page to reach the
    // seed's boundary.
    expect(events.calls.filter(c => c.cursor !== undefined).length).toBeGreaterThanOrEqual(1)
  })

  it("second prompt sends to the same vendor session; old events never end the new turn", async () => {
    const events = new FakeEvents()
    events.push(assistantEvent(1, "turn one"), resultEvent(2))
    const h = harness({ api: events.api() })
    const sessionId = await newSession(h)

    // Turn 1 — establish the high-water (result at seq 2).
    await h.agent.prompt(prompt(sessionId, "first"))
    h.conn.sessionUpdate.mockClear()

    // Turn 2: the new events written after the send (the pre-prompt
    // high-water GET has already run by the time sendPrompt is called).
    h.send.mockImplementation(async () => {
      events.push(assistantEvent(3, "turn two"), resultEvent(4))
      return { stdout: "Sent to cloud session." }
    })

    const res = await h.agent.prompt(prompt(sessionId, "second"))
    expect(res.stopReason).toBe("end_turn")
    expect(h.start).toHaveBeenCalledTimes(1) // NOT called again
    expect(h.send).toHaveBeenCalledWith(VENDOR_ID, "second", { cwd: "/repo" })
    // Only the turn-2 result projects a usage_update — the turn-1 result is
    // below lastSeq and never re-projected.
    expect(
      updates(h.conn).filter(u => u.sessionUpdate === "usage_update"),
    ).toHaveLength(1)
  })

  it("never replays a follow-up turn's user-event prompt echo as a chunk", async () => {
    const events = new FakeEvents()
    events.push(resultEvent(1))
    const h = harness({ api: events.api() })
    const sessionId = await newSession(h)
    await h.agent.prompt(prompt(sessionId, "first"))
    h.conn.sessionUpdate.mockClear()

    h.send.mockImplementation(async () => {
      events.push(
        promptEchoEvent(2, "second"),
        userEventWithChunkPayload(3, "second again"),
        toolResultEvent(4),
        resultEvent(5),
      )
      return { stdout: "Sent to cloud session." }
    })

    const res = await h.agent.prompt(prompt(sessionId, "second"))
    expect(res.stopReason).toBe("end_turn")

    const projected = updates(h.conn)
    const chunks = JSON.stringify(
      projected.filter(u => u.sessionUpdate === "agent_message_chunk"),
    )
    // The echoed prompt is never replayed to the host…
    expect(chunks).not.toContain('"text":"second"')
    expect(chunks).not.toContain("second again")
    // …but tool results (also `user` events) still project.
    expect(projected.some(u => u.sessionUpdate === "tool_call_update")).toBe(true)
    // Exactly one usage_update: the turn-2 result, not a replayed turn-1 one.
    expect(
      projected.filter(u => u.sessionUpdate === "usage_update"),
    ).toHaveLength(1)
  })

  it("retries transient listEvents failures with backoff, then finishes the turn on the vendor result", async () => {
    let calls = 0
    const api: CloudEventsClient = {
      async listEvents() {
        calls += 1
        if (calls <= 3) {
          throw new Error(
            "claude code cloud: GET /v1/code/sessions/cse_fake/events failed: HTTP 503",
          )
        }
        return {
          data: [resultEvent(2), assistantEvent(1, "recovered")],
          resume_cursor: "1",
        }
      },
    }
    const h = harness({ api, pollInitialMs: 10, pollMaxMs: 40 })
    const sessionId = await newSession(h)
    const res = await h.agent.prompt(prompt(sessionId, "hi"))

    expect(res.stopReason).toBe("end_turn")
    expect(calls).toBe(4) // three transient failures, then the page
    expect(h.sleepDelays).toEqual([10, 20, 40]) // backoff between retries
    expect(
      updates(h.conn).some(
        u =>
          u.sessionUpdate === "agent_message_chunk" &&
          JSON.stringify(u).includes("recovered"),
      ),
    ).toBe(true)
  })

  it("fails the turn after 5 consecutive transient listEvents failures", async () => {
    let calls = 0
    const api: CloudEventsClient = {
      async listEvents() {
        calls += 1
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET" },
        })
      },
    }
    const h = harness({ api, pollInitialMs: 10, pollMaxMs: 40 })
    const sessionId = await newSession(h)

    await expect(h.agent.prompt(prompt(sessionId, "hi"))).rejects.toThrow(
      /fetch failed/,
    )
    expect(calls).toBe(MAX_LIST_EVENTS_FAILURES) // no unbounded retrying
    expect(h.sleepDelays).toEqual([10, 20, 40, 40]) // backoff before each
    // Never ended the turn on anything but a vendor `result`.
    expect(updates(h.conn).some(u => u.sessionUpdate === "usage_update")).toBe(false)
  })

  it("fails the turn immediately on a non-transient listEvents error", async () => {
    let calls = 0
    const api: CloudEventsClient = {
      async listEvents() {
        calls += 1
        throw new Error(
          "claude code cloud: GET /v1/code/sessions/cse_fake/events failed: HTTP 404",
        )
      },
    }
    const h = harness({ api })
    const sessionId = await newSession(h)

    await expect(h.agent.prompt(prompt(sessionId, "hi"))).rejects.toThrow(/HTTP 404/)
    expect(calls).toBe(1)
    expect(h.sleep).not.toHaveBeenCalled()
  })

  it("an error result stops as refusal and surfaces the error text", async () => {
    const events = new FakeEvents()
    events.push(
      resultEvent(1, {
        subtype: "error",
        is_error: true,
        result: "the vendor refused the turn",
        total_cost_usd: 0.01,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    )
    const h = harness({ api: events.api() })
    const sessionId = await newSession(h)
    const res = await h.agent.prompt(prompt(sessionId, "boom"))
    expect(res.stopReason).toBe("refusal")
    const projected = updates(h.conn)
    expect(
      projected.some(
        u =>
          u.sessionUpdate === "agent_message_chunk" &&
          JSON.stringify(u).includes("the vendor refused the turn"),
      ),
    ).toBe(true)
  })

  it("a result without usage emits no usage_update (unmeasured, not zero)", async () => {
    const events = new FakeEvents()
    events.push(event(1, "result", { type: "result", subtype: "success", is_error: false }))
    const h = harness({ api: events.api() })
    const sessionId = await newSession(h)
    const res = await h.agent.prompt(prompt(sessionId, "hi"))
    expect(res.stopReason).toBe("end_turn")
    expect(updates(h.conn).some(u => u.sessionUpdate === "usage_update")).toBe(false)
  })

  it("backs the poll off from the initial to the max interval", async () => {
    const events = new FakeEvents()
    let sleeps = 0
    const h = harness({
      api: events.api(),
      pollInitialMs: 10,
      pollMaxMs: 40,
      onSleep: () => {
        sleeps += 1
        if (sleeps === 4) events.push(resultEvent(1))
      },
    })
    const sessionId = await newSession(h)
    await h.agent.prompt(prompt(sessionId, "slow turn"))
    expect(h.sleepDelays).toEqual([10, 20, 40, 40])
  })

  it("session/cancel is unsupported", async () => {
    const h = harness({ api: new FakeEvents().api() })
    await expect(h.agent.cancel({ sessionId: "s" } as never)).rejects.toThrow(
      /session\/cancel is unsupported/,
    )
  })

  it("reports an empty configurable-option set (no model menu)", async () => {
    const h = harness({ api: new FakeEvents().api() })
    await expect(
      h.agent.setSessionConfigOption({} as never),
    ).resolves.toEqual({ configOptions: [] })
    await expect(h.agent.setSessionMode({} as never)).resolves.toEqual({})
  })
})

describe("ClaudeCloudAcpAgent — session/load re-attach (AIP-66 §5)", () => {
  async function loadSession(
    h: Harness,
    sessionId: string,
    cwd = "/repo",
    mcpServers: unknown[] = [],
  ): Promise<unknown> {
    return h.agent.loadSession({
      sessionId,
      cwd,
      mcpServers,
    } as unknown as LoadSessionRequest)
  }

  it("initialize advertises the loadSession capability", async () => {
    const h = harness({ api: new FakeEvents().api() })
    const res = await h.agent.initialize({} as never)
    expect(res.agentCapabilities?.loadSession).toBe(true)
  })

  it("session/load adopts the vendor id — the next prompt SENDS, never starts a new cloud session", async () => {
    const events = new FakeEvents()
    // Pre-existing history ending in an OLD result (seq 1).
    events.push(resultEvent(1))
    const h = harness({ api: events.api() })
    await loadSession(h, VENDOR_ID)
    // The seed is ONE newest-page GET (no cursor, no backward paging).
    expect(events.calls).toEqual([{ id: VENDOR_ID }])

    // The post-attach turn's result appears once sendPrompt runs.
    h.send.mockImplementation(async () => {
      events.push(resultEvent(2))
      return { stdout: "Sent to cloud session." }
    })

    const res: PromptResponse = await h.agent.prompt(prompt(VENDOR_ID, "again"))
    expect(res.stopReason).toBe("end_turn")
    // Re-attach goes through sendPrompt — a resumed relay MUST NOT start a
    // replacement vendor session (AIP-66 §5).
    expect(h.start).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith(VENDOR_ID, "again", { cwd: "/repo" })
    // The old result (seq 1) is at/below the seeded high-water: it never
    // projects and never ends a turn. Exactly one usage_update — the new one.
    expect(
      updates(h.conn).filter(u => u.sessionUpdate === "usage_update"),
    ).toHaveLength(1)
    // All reads were newest-page reads (no cursor).
    expect(events.calls.every(c => c.cursor === undefined)).toBe(true)
  })

  it("session/load seeds past a multi-page history — an older result cannot end the first post-attach prompt", async () => {
    // pageSize 2: the history is many pages deep. A single newest-page GET
    // still seeds lastSeq above the previous turn's OLD result (seq 2),
    // because only the max sequence_num on the newest page matters.
    const events = new FakeEvents(2)
    events.push(
      assistantEvent(1, "older page"),
      resultEvent(2, { total_cost_usd: 9.99, usage: { input_tokens: 999, output_tokens: 999 } }),
      assistantEvent(3, "newer page"),
      assistantEvent(4, "newest"),
    )
    const h = harness({ api: events.api() })
    await loadSession(h, VENDOR_ID)
    // ONE newest-page GET — backward paging is not needed for the seed.
    expect(events.calls).toEqual([{ id: VENDOR_ID }])

    h.conn.sessionUpdate.mockClear()
    h.send.mockImplementation(async () => {
      events.push(resultEvent(5))
      return { stdout: "Sent to cloud session." }
    })
    const res: PromptResponse = await h.agent.prompt(prompt(VENDOR_ID, "again"))
    expect(res.stopReason).toBe("end_turn")
    // The turn did NOT end on the (seeded) older result: its distinctive
    // cost/usage never projects, only the new turn's result does.
    const projected = updates(h.conn)
    expect(JSON.stringify(projected)).not.toContain("9.99")
    expect(
      projected.filter(u => u.sessionUpdate === "usage_update"),
    ).toHaveLength(1)
  })

  it("session/load refuses an id the vendor could never own — and starts nothing in its place", async () => {
    const h = harness({ api: new FakeEvents().api() })
    await expect(loadSession(h, "acp-uuid-never-learned")).rejects.toThrow(
      /vendor session id/,
    )
    expect(h.start).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it("session/load accepts the API's cse_ spelling too", async () => {
    const events = new FakeEvents()
    events.push(resultEvent(1))
    const h = harness({ api: events.api() })
    await loadSession(h, "cse_01FakeId")
    h.send.mockImplementation(async () => {
      events.push(resultEvent(2))
      return { stdout: "Sent to cloud session." }
    })
    const res = await h.agent.prompt(prompt(VENDOR_ID, "again"))
    expect(res.stopReason).toBe("end_turn")
    // Normalized to the CLI's session_ spelling before hitting the vendor.
    expect(h.send).toHaveBeenCalledWith(VENDOR_ID, "again", { cwd: "/repo" })
  })

  it("session/load refuses mcpServers (AIP-66 §4 backstop)", async () => {
    const h = harness({ api: new FakeEvents().api() })
    await expect(
      loadSession(h, VENDOR_ID, "/repo", [{ name: "x" }]),
    ).rejects.toThrow(/mcpServers is not supported/)
    expect(h.validateRepo).not.toHaveBeenCalled()
  })

  it("session/load re-validates the repo source before adopting anything (AIP-66 §3)", async () => {
    const h = harness({ api: new FakeEvents().api() })
    h.validateRepo.mockRejectedValueOnce(new Error("working tree is dirty"))
    await expect(loadSession(h, VENDOR_ID)).rejects.toThrow(/working tree is dirty/)
    expect(h.send).not.toHaveBeenCalled()
  })

  it("session/load validates the session id BEFORE the repo source — a bad id reports its error first", async () => {
    const h = harness({ api: new FakeEvents().api() })
    // Even with a repo the validator would reject, the malformed id is the
    // error the caller hears.
    h.validateRepo.mockRejectedValueOnce(new Error("working tree is dirty"))
    await expect(loadSession(h, "acp-uuid-never-learned")).rejects.toThrow(
      /vendor session id/,
    )
    expect(h.validateRepo).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it("reports the learned identity to the host's meta file — and never a credential (AIP-66 §8)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agp-cloud-meta-"))
    const path = join(dir, "cloud-session.json")
    const prev = process.env[CLOUD_SESSION_META_FILE_ENV]
    process.env[CLOUD_SESSION_META_FILE_ENV] = path
    try {
      const events = new FakeEvents()
      events.push(resultEvent(1))
      const h = harness({ api: events.api() })
      const id = await newSession(h)
      await h.agent.prompt(prompt(id, "hello"))

      const raw = await readFile(path, "utf8")
      expect(JSON.parse(raw)).toEqual({
        vendor: CLOUD_VENDOR_SLUG,
        sessionId: VENDOR_ID,
        url: VENDOR_URL,
      })
      // Exactly the three §5 fields — the vendor's OAuth credential never
      // enters this file.
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["sessionId", "url", "vendor"])
      expect(raw).not.toMatch(/accessToken|oauth|Bearer/i)
    } finally {
      if (prev === undefined) delete process.env[CLOUD_SESSION_META_FILE_ENV]
      else process.env[CLOUD_SESSION_META_FILE_ENV] = prev
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("session/load re-reports the adopted id, preserving the learned URL on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agp-cloud-meta-"))
    const path = join(dir, "cloud-session.json")
    const prev = process.env[CLOUD_SESSION_META_FILE_ENV]
    process.env[CLOUD_SESSION_META_FILE_ENV] = path
    try {
      // The file the FIRST spawn's relay wrote (id + URL learned at start).
      await writeFile(
        path,
        JSON.stringify({ vendor: CLOUD_VENDOR_SLUG, sessionId: VENDOR_ID, url: VENDOR_URL }),
        "utf8",
      )
      const events = new FakeEvents()
      events.push(resultEvent(1))
      const h = harness({ api: events.api() })
      await loadSession(h, VENDOR_ID)
      // A load carries no URL of its own — the one already on disk survives.
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        vendor: CLOUD_VENDOR_SLUG,
        sessionId: VENDOR_ID,
        url: VENDOR_URL,
      })
    } finally {
      if (prev === undefined) delete process.env[CLOUD_SESSION_META_FILE_ENV]
      else process.env[CLOUD_SESSION_META_FILE_ENV] = prev
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("no meta file env → the side file is simply not written (best-effort)", async () => {
    const prev = process.env[CLOUD_SESSION_META_FILE_ENV]
    delete process.env[CLOUD_SESSION_META_FILE_ENV]
    try {
      const events = new FakeEvents()
      events.push(resultEvent(1))
      const h = harness({ api: events.api() })
      await expect(loadSession(h, VENDOR_ID)).resolves.toBeDefined()
    } finally {
      if (prev !== undefined) process.env[CLOUD_SESSION_META_FILE_ENV] = prev
    }
  })
})

describe("result helpers", () => {
  it("maps success + error stop reasons", () => {
    expect(resultStopReason({ is_error: false, subtype: "success" })).toBe("end_turn")
    expect(resultStopReason({ is_error: true, subtype: "success" })).toBe("refusal")
    expect(resultStopReason({ subtype: "error" })).toBe("refusal")
    expect(resultStopReason(undefined)).toBe("end_turn")
  })

  it("extracts the usage_update only when the vendor reported usage", () => {
    const withUsage = resultEventUpdates(resultEvent(1).payload)
    expect(withUsage).toHaveLength(1)
    expect(withUsage[0]).toMatchObject({ sessionUpdate: "usage_update" })
    expect(resultEventUpdates({ type: "result" })).toEqual([])
    expect(
      resultEventUpdates({ type: "result", total_cost_usd: 0.05 }),
    ).toHaveLength(1)
  })
})
