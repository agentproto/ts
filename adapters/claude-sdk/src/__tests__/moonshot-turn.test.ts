/**
 * Coverage for the Moonshot gateway turn + the idle-stall watchdog.
 *
 * `gateway-modes.test.ts` only checks manifest env wiring; it never drives a
 * turn. These tests DRIVE a turn end to end. Two things are verified:
 *
 *  1. A Moonshot-shaped SDK stream — `system/init` (a non-`msg_` `chatcmpl-…`
 *     id) → a `thinking` block with an EMPTY `signature` → a `text` block → the
 *     terminal `result` — drives to completion. This is exactly the response
 *     shape that was suspected of wedging the turn; the SDK consumes it fine,
 *     and the live e2e below confirms the same against the real endpoint (a
 *     real `kimi-k2.7-code` turn reaches `stop_reason: end_turn` with text).
 *
 *  2. The idle watchdog terminates a genuinely WEDGED stream — one that yields
 *     some content then stops emitting messages and never closes — with a
 *     surfaced error instead of hanging with zero output. On the pre-watchdog
 *     `#drive` (an unbounded `for await`) that case hangs and fails on the test
 *     timeout. This is the defensive safety net for a wedged SDK child (in
 *     practice, a conflicting host env — a stray `ANTHROPIC_BASE_URL` or a
 *     `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX` toggle — leaking into the spawned
 *     subprocess), independent of any response shape.
 *
 * The host is driven through a REAL `AgentSideConnection` over in-memory
 * streams so the fakes stay fully typed (no casts): the connection is a class
 * with a private field, so a plain object can't satisfy it structurally.
 */

import {
  AgentSideConnection,
  type AnyMessage,
  type Stream,
} from "@agentclientprotocol/sdk"
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultSuccess,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it } from "vitest"
import { ClaudeSdkAcpAgent, type QueryFn } from "../acp-host.js"
import type { ClaudeSdkConfig } from "../options.js"

const MOONSHOT_MODEL = "kimi-k2.7-code"
// Moonshot returns a non-Anthropic message id (`chatcmpl-…`, not `msg_…`).
const MOONSHOT_MSG_ID = "chatcmpl-9f3a1b2c"

// ---- Factories for a Moonshot-shaped SDK message stream ---------------------
//
// These build the SDK message shapes as literals, then cast at the boundary
// (`as unknown as …`) — the same pattern message-map.test.ts / acp-host.test.ts
// use. The cast is deliberate: the SDK types `usage` as `BetaUsage` (and, on
// the result, `NonNullableUsage` — every BetaUsage key required non-null), and
// that shape drifts across `@anthropic-ai/sdk` versions (it gains fields like
// `server_tool_use` / `service_tier`). A fully-typed literal would compile
// against one version and fail check-types under a newer resolution. These are
// inert test fakes — the tests assert on turn flow (stopReason) and emitted
// chunk text, never on usage numbers — so pinning the exact `Beta*` shape buys
// nothing but version fragility.

function moonshotInit(sessionId: string): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "temporary",
    claude_code_version: "0.0.0-test",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: MOONSHOT_MODEL,
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  } as unknown as SDKSystemMessage
}

/** The suspected-but-benign shape: Moonshot ships `signature: ""`. */
function moonshotThinking(sessionId: string): SDKAssistantMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
    message: {
      id: MOONSHOT_MSG_ID,
      type: "message",
      role: "assistant",
      model: MOONSHOT_MODEL,
      stop_reason: null,
      stop_sequence: null,
      content: [{ type: "thinking", thinking: "Answer with PONG.", signature: "" }],
      usage: {
        input_tokens: 5,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as SDKAssistantMessage
}

function moonshotText(sessionId: string, text: string): SDKAssistantMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
    message: {
      id: MOONSHOT_MSG_ID,
      type: "message",
      role: "assistant",
      model: MOONSHOT_MODEL,
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text, citations: null }],
      usage: {
        input_tokens: 5,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as SDKAssistantMessage
}

function moonshotResult(sessionId: string, text: string): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1300,
    duration_api_ms: 1200,
    is_error: false,
    num_turns: 1,
    result: text,
    stop_reason: "end_turn",
    total_cost_usd: 0.0001,
    usage: {
      input_tokens: 5,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {
      [MOONSHOT_MODEL]: {
        inputTokens: 5,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.0001,
        contextWindow: 200_000,
        maxOutputTokens: 8192,
      },
    },
    permission_denials: [],
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  } as unknown as SDKResultSuccess
}

// ---- Test harness: a real AgentSideConnection over in-memory streams --------

interface Harness {
  readonly agent: ClaudeSdkAcpAgent
  /** Raw JSON-RPC frames the host emitted (each `session/update` notification). */
  readonly captured: AnyMessage[]
  close(): void
}

function makeHarness(config: ClaudeSdkConfig, query: QueryFn): Harness {
  const captured: AnyMessage[] = []
  const writable = new WritableStream<AnyMessage>({
    write(chunk) {
      captured.push(chunk)
    },
  })
  let readableController: ReadableStreamDefaultController<AnyMessage> | undefined
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      readableController = controller
    },
  })
  const stream: Stream = { writable, readable }

  let agent: ClaudeSdkAcpAgent | undefined
  // The constructor calls back synchronously to build the agent handler.
  new AgentSideConnection((conn) => {
    agent = new ClaudeSdkAcpAgent(conn, config, query)
    return agent
  }, stream)
  if (!agent) throw new Error("AgentSideConnection did not build the agent")

  return {
    agent,
    captured,
    close() {
      readableController?.close()
    },
  }
}

/** Read a property from an unknown value as `unknown` (no cast, no `any`). */
function field(input: unknown, key: string): unknown {
  if (input && typeof input === "object" && key in input) {
    return Reflect.get(input, key)
  }
  return undefined
}

function stringField(input: unknown, key: string): string | undefined {
  const value = field(input, key)
  return typeof value === "string" ? value : undefined
}

/** The kinds of `session/update` the host emitted, in order. */
function updateKinds(captured: AnyMessage[]): string[] {
  const kinds: string[] = []
  for (const frame of captured) {
    if (stringField(frame, "method") !== "session/update") continue
    const update = field(field(frame, "params"), "update")
    const kind = stringField(update, "sessionUpdate")
    if (kind !== undefined) kinds.push(kind)
  }
  return kinds
}

/** The text of every `agent_message_chunk` the host emitted, in order. */
function agentChunkTexts(captured: AnyMessage[]): string[] {
  const texts: string[] = []
  for (const frame of captured) {
    if (stringField(frame, "method") !== "session/update") continue
    const update = field(field(frame, "params"), "update")
    if (stringField(update, "sessionUpdate") !== "agent_message_chunk") continue
    const text = stringField(field(update, "content"), "text")
    if (text !== undefined) texts.push(text)
  }
  return texts
}

function newSessionId(harness: Harness): Promise<string> {
  return harness.agent
    .newSession({ cwd: "/tmp", mcpServers: [] })
    .then((r) => r.sessionId)
}

describe("claude-sdk moonshot turn (mock SDK stream)", () => {
  it("drives an empty-signature thinking stream to completion", async () => {
    const query: QueryFn = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        const sid = "sdk-moonshot-1"
        yield moonshotInit(sid)
        yield moonshotThinking(sid)
        yield moonshotText(sid, "PONG")
        yield moonshotResult(sid, "PONG")
      })()

    const harness = makeHarness({ model: MOONSHOT_MODEL }, query)
    try {
      const sessionId = await newSessionId(harness)
      const res = await harness.agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Reply PONG" }],
      })

      // The turn TERMINATES on the empty-signature / `chatcmpl-…` shape.
      expect(res.stopReason).toBe("end_turn")
      // …and the assistant text made it through.
      expect(agentChunkTexts(harness.captured)).toContain("PONG")
      expect(updateKinds(harness.captured)).toEqual([
        "agent_message_chunk",
        "usage_update",
      ])
    } finally {
      harness.close()
    }
  })

  it("ends the turn (does not hang) when the stream never yields a terminal result", async () => {
    // The wedged-stream failure mode: content streams, then the iterator never
    // delivers `result` and never closes. Pre-watchdog `#drive` awaits forever.
    const query: QueryFn = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        const sid = "sdk-moonshot-hang"
        yield moonshotInit(sid)
        yield moonshotThinking(sid)
        yield moonshotText(sid, "PONG")
        // Never resolves → the SDK iterator hangs with no terminal `result`.
        await new Promise<never>(() => {})
      })()

    // Tiny idle window so the watchdog fires fast in the test.
    const harness = makeHarness({ model: MOONSHOT_MODEL, idleTimeoutMs: 40 }, query)
    try {
      const sessionId = await newSessionId(harness)
      const res = await harness.agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Reply PONG" }],
      })

      // The turn ENDS instead of hanging forever …
      expect(res.stopReason).toBe("refusal")
      // … streamed text still surfaced before the stall …
      expect(agentChunkTexts(harness.captured)).toContain("PONG")
      // … and the stall is surfaced as an error chunk (not a silent hang).
      const errorChunk = agentChunkTexts(harness.captured).find((t) =>
        t.includes("stalled"),
      )
      expect(errorChunk).toBeDefined()
      expect(errorChunk).toContain("claude-sdk error")
    } finally {
      harness.close()
    }
  }, 5_000)

  it("honours idleTimeoutMs: 0 by not arming the watchdog on a normal stream", async () => {
    const query: QueryFn = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        const sid = "sdk-moonshot-nowatch"
        yield moonshotInit(sid)
        yield moonshotText(sid, "PONG")
        yield moonshotResult(sid, "PONG")
      })()

    const harness = makeHarness({ model: MOONSHOT_MODEL, idleTimeoutMs: 0 }, query)
    try {
      const sessionId = await newSessionId(harness)
      const res = await harness.agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Reply PONG" }],
      })
      expect(res.stopReason).toBe("end_turn")
      expect(agentChunkTexts(harness.captured)).toContain("PONG")
    } finally {
      harness.close()
    }
  })
})

/**
 * Gated live e2e (skipped without `MOONSHOT_API_KEY`) — mirrors the repo's
 * `describe.skipIf(!process.env.X_API_KEY)` convention. Drives a REAL turn
 * against Moonshot's Anthropic-compatible endpoint and asserts genuine
 * completion: `stopReason: "end_turn"` plus the assistant text.
 *
 * The assertion cannot silently pass on a hang: `idleTimeoutMs` bounds each
 * wait, so a wedged stream aborts to `stopReason: "refusal"` well inside the
 * test's own ceiling and FAILS the `end_turn` assertion rather than the test
 * timing out or (worse) reporting a false pass. Run with the key set to verify
 * the arm end to end:
 *   MOONSHOT_API_KEY=… npx vitest run src/__tests__/moonshot-turn.test.ts \
 *     -t "completes a real moonshot turn"
 */
describe.skipIf(!process.env.MOONSHOT_API_KEY)(
  "claude-sdk moonshot turn (live e2e)",
  () => {
    it("completes a real moonshot turn", async () => {
      const config: ClaudeSdkConfig = {
        model: MOONSHOT_MODEL,
        baseUrl: "https://api.moonshot.ai/anthropic",
        authToken: process.env.MOONSHOT_API_KEY,
        thinking: true,
        cwd: "/tmp",
        // Bound the wait so a stall surfaces as a refusal (failing the
        // assertion) instead of hanging up to the test ceiling.
        idleTimeoutMs: 45_000,
      }
      const harness = makeHarness(config, sdkQuery)
      try {
        const sessionId = await newSessionId(harness)
        const res = await harness.agent.prompt({
          sessionId,
          prompt: [{ type: "text", text: "Reply with exactly: PONG" }],
        })
        expect(res.stopReason).toBe("end_turn")
        expect(agentChunkTexts(harness.captured).join("")).toContain("PONG")
      } finally {
        harness.close()
      }
    }, 60_000)
  },
)
