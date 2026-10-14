import { describe, expect, it, vi } from "vitest"
import type {
  AgentSideConnection,
  NewSessionRequest,
  PromptRequest,
  PromptResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk"
import {
  ClaudeCloudAcpAgent,
  MAX_LIST_EVENTS_FAILURES,
  POLL_INITIAL_MS,
  resultEventUpdates,
  resultStopReason,
  type CloudCliDeps,
  type CloudEventsClient,
} from "../acp-server.js"
import type { CloudEventsPage, CloudSessionEvent } from "../sessions-api.js"

// ── fixtures (FAKE ids/text, shaped like the 2026-10-14 observations) ──────

const VENDOR_ID = "session_01FakeId"
const VENDOR_URL = "https://claude.ai/code/session_01FakeId?tab=cloud"

function assistantEvent(id: string, text: string): CloudSessionEvent {
  return {
    created_at: `2026-10-14T10:00:${id}.000Z`,
    event_id: id,
    event_type: "assistant",
    payload: {
      type: "assistant",
      message: {
        id: "msg_fake",
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
    },
  }
}

function toolUseEvent(id: string): CloudSessionEvent {
  return {
    created_at: `2026-10-14T10:00:${id}.000Z`,
    event_id: id,
    event_type: "assistant",
    payload: {
      type: "assistant",
      message: {
        id: "msg_fake",
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
    },
  }
}

function toolResultEvent(id: string): CloudSessionEvent {
  return {
    created_at: `2026-10-14T10:00:${id}.000Z`,
    event_id: id,
    event_type: "user",
    payload: {
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
    },
  }
}

/** Follow-up-turn prompt echo: the vendor echoes the user's own prompt back
 *  as a `user` event carrying the prompt text (observed on turn 2+). */
function promptEchoEvent(id: string, text: string): CloudSessionEvent {
  return {
    created_at: `2026-10-14T10:00:${id}.000Z`,
    event_id: id,
    event_type: "user",
    payload: {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      session_id: VENDOR_ID,
      parent_tool_use_id: null,
    },
  }
}

/** A `user` event whose payload is NOT an SDK user message: projecting it
 *  through the generic mapper would emit a chunk. The echo guard keys off
 *  the EVENT type, so this must be dropped too. */
function userEventWithChunkPayload(id: string, text: string): CloudSessionEvent {
  return {
    created_at: `2026-10-14T10:00:${id}.000Z`,
    event_id: id,
    event_type: "user",
    payload: {
      type: "assistant",
      message: {
        id: "msg_fake",
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
    },
  }
}

function resultEvent(
  id: string,
  overrides: Record<string, unknown> = {},
): CloudSessionEvent {
  return {
    created_at: `2026-10-14T10:00:${id}.000Z`,
    event_id: id,
    event_type: "result",
    payload: {
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
    },
  }
}

/** Events client fed by a queue of pages; records the cursor of each call. */
function fakeApi(pages: CloudEventsPage[]): {
  api: CloudEventsClient
  calls: Array<{ id: string; cursor?: string }>
} {
  const calls: Array<{ id: string; cursor?: string }> = []
  let i = 0
  return {
    api: {
      async listEvents(id, opts) {
        calls.push({ id, ...(opts?.cursor !== undefined ? { cursor: opts.cursor } : {}) })
        // Repeat the last page when the queue runs dry (turn still running).
        return pages[Math.min(i++, pages.length - 1)] ?? { data: [] }
      },
    },
    calls,
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
}

function harness(opts: {
  api: CloudEventsClient
  pollInitialMs?: number
  pollMaxMs?: number
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
  })
  const validateRepo = vi.fn(async () => {})
  const cli: CloudCliDeps = {
    startCloudSession: start as unknown as CloudCliDeps["startCloudSession"],
    sendPrompt: send as unknown as CloudCliDeps["sendPrompt"],
  }
  const agent = new ClaudeCloudAcpAgent(conn as unknown as AgentSideConnection, {
    api: opts.api,
    cli,
    validateRepo: validateRepo as unknown as (cwd: string) => Promise<void>,
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

// ── tests ───────────────────────────────────────────────────────────────────

describe("ClaudeCloudAcpAgent", () => {
  it("session/new validates the repo source before creating anything", async () => {
    const { api } = fakeApi([])
    const h = harness({ api })
    h.validateRepo.mockRejectedValueOnce(new Error("working tree is dirty"))
    await expect(newSession(h)).rejects.toThrow(/working tree is dirty/)

    const h2 = harness({ api })
    const id = await newSession(h2, "/repo")
    expect(h2.validateRepo).toHaveBeenCalledWith("/repo")
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("session/new refuses mcpServers (AIP-66 §4)", async () => {
    const { api } = fakeApi([])
    const h = harness({ api })
    await expect(newSession(h, "/repo", [{ name: "x" }])).rejects.toThrow(
      /mcpServers is not supported/,
    )
    expect(h.validateRepo).not.toHaveBeenCalled()
  })

  it("first prompt starts a cloud session, surfaces the URL, and ends on the new result with usage", async () => {
    const { api, calls } = fakeApi([
      // Turn-1 events arrive across polls: first page has partial turn-1
      // events (+ the cursor to resume from), second poll sees the result.
      {
        data: [assistantEvent("a1", "Working on it")],
        resume_cursor: "cur-0",
      },
      {
        data: [
          resultEvent("r1"),
          toolResultEvent("u1"),
          toolUseEvent("a2"),
          assistantEvent("a1", "Working on it"),
        ],
        resume_cursor: "cur-1",
      },
    ])
    const h = harness({ api, pollInitialMs: 10 })
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
    expect(
      projected.some(u => u.sessionUpdate === "tool_call"),
    ).toBe(true)
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
    // Polling round-trips the API's resume_cursor from the previous page.
    expect(calls).toEqual([
      { id: VENDOR_ID },
      { id: VENDOR_ID, cursor: "cur-0" },
    ])
  })

  it("second prompt sends to the same vendor session; old events never end the new turn", async () => {
    const { api } = fakeApi([
      // Turn 1: the result ends it immediately.
      { data: [resultEvent("r1")], resume_cursor: "cur-1" },
      // Turn 2, poll 1: ONLY the already-seen turn-1 events (incl. the old
      // result) — the turn must NOT end here.
      { data: [resultEvent("r1")], resume_cursor: "cur-1" },
      // Turn 2, poll 2: the NEW turn-2 result.
      { data: [resultEvent("r2")], resume_cursor: "cur-2" },
    ])
    const h = harness({ api })
    const sessionId = await newSession(h)

    // Turn 1 — establish seen events.
    await h.agent.prompt(prompt(sessionId, "first"))
    h.conn.sessionUpdate.mockClear()

    // Turn 2.
    const res = await h.agent.prompt(prompt(sessionId, "second"))
    expect(res.stopReason).toBe("end_turn")
    expect(h.start).toHaveBeenCalledTimes(1) // NOT called again
    expect(h.send).toHaveBeenCalledWith(VENDOR_ID, "second", { cwd: "/repo" })
    // Exactly one turn-2 result projection, not two.
    expect(h.sleep).toHaveBeenCalledTimes(1) // one empty(ish) poll before r2
  })

  it("never replays a follow-up turn's user-event prompt echo as a chunk", async () => {
    const { api } = fakeApi([
      // Turn 1: the result ends it.
      { data: [resultEvent("r1")], resume_cursor: "cur-1" },
      // Turn 2: the vendor echoes the prompt as a `user` event (twice, once
      // in the plain echo shape and once under a payload that the generic
      // mapper WOULD turn into a chunk), a real tool_result, then the result.
      {
        data: [
          promptEchoEvent("u2", "second"),
          userEventWithChunkPayload("u3", "second again"),
          toolResultEvent("u4"),
          resultEvent("r2"),
        ],
        resume_cursor: "cur-2",
      },
    ])
    const h = harness({ api })
    const sessionId = await newSession(h)
    await h.agent.prompt(prompt(sessionId, "first"))
    h.conn.sessionUpdate.mockClear()

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
    expect(
      projected.some(u => u.sessionUpdate === "tool_call_update"),
    ).toBe(true)
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
          data: [assistantEvent("a1", "recovered"), resultEvent("r1")],
          resume_cursor: "cur-1",
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
    expect(
      updates(h.conn).some(u => u.sessionUpdate === "usage_update"),
    ).toBe(false)
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

    await expect(h.agent.prompt(prompt(sessionId, "hi"))).rejects.toThrow(
      /HTTP 404/,
    )
    expect(calls).toBe(1)
    expect(h.sleep).not.toHaveBeenCalled()
  })

  it("an error result stops as refusal and surfaces the error text", async () => {
    const { api } = fakeApi([
      {
        data: [
          resultEvent("r1", {
            subtype: "error",
            is_error: true,
            result: "the vendor refused the turn",
            total_cost_usd: 0.01,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ],
      },
    ])
    const h = harness({ api })
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
    const { api } = fakeApi([
      {
        data: [
          {
            created_at: "2026-10-14T10:00:00.000Z",
            event_id: "r0",
            event_type: "result",
            payload: { type: "result", subtype: "success", is_error: false },
          },
        ],
      },
    ])
    const h = harness({ api })
    const sessionId = await newSession(h)
    const res = await h.agent.prompt(prompt(sessionId, "hi"))
    expect(res.stopReason).toBe("end_turn")
    expect(
      updates(h.conn).some(u => u.sessionUpdate === "usage_update"),
    ).toBe(false)
  })

  it("backs the poll off from the initial to the max interval", async () => {
    const { api } = fakeApi([
      { data: [] },
      { data: [] },
      { data: [] },
      { data: [] },
      { data: [resultEvent("r1")] },
    ])
    const h = harness({ api, pollInitialMs: 10, pollMaxMs: 40 })
    const sessionId = await newSession(h)
    await h.agent.prompt(prompt(sessionId, "slow turn"))
    expect(h.sleepDelays).toEqual([10, 20, 40, 40])
  })

  it("session/cancel is unsupported", async () => {
    const { api } = fakeApi([])
    const h = harness({ api })
    await expect(
      h.agent.cancel({ sessionId: "s" } as never),
    ).rejects.toThrow(/session\/cancel is unsupported/)
  })

  it("reports an empty configurable-option set (no model menu)", async () => {
    const { api } = fakeApi([])
    const h = harness({ api })
    await expect(
      h.agent.setSessionConfigOption({} as never),
    ).resolves.toEqual({ configOptions: [] })
    await expect(h.agent.setSessionMode({} as never)).resolves.toEqual({})
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
    const withUsage = resultEventUpdates(
      resultEvent("r1").payload,
    )
    expect(withUsage).toHaveLength(1)
    expect(withUsage[0]).toMatchObject({ sessionUpdate: "usage_update" })
    expect(resultEventUpdates({ type: "result" })).toEqual([])
    expect(
      resultEventUpdates({ type: "result", total_cost_usd: 0.05 }),
    ).toHaveLength(1)
  })
})
