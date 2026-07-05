/**
 * Regression coverage for the Moonshot gateway STALL.
 *
 * `gateway-modes.test.ts` only checks manifest env wiring; it never drives a
 * turn, which is why it stayed green while a real moonshot turn hung forever.
 * These tests DRIVE a turn to completion against a mock Moonshot-shaped SDK
 * stream — `system/init` (non-`msg_` id) → a `thinking` block with an EMPTY
 * `signature` → a `text` block → the terminal `result` — and, critically, one
 * where the stream never delivers a terminal `result` and never closes (the
 * observed moonshot failure). The latter asserts the turn TERMINATES via the
 * idle watchdog instead of hanging with zero output; on the pre-fix `#drive`
 * (an unbounded `for await`) that test hangs and fails on the test timeout.
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

// ---- Typed factories for a Moonshot-shaped SDK message stream ---------------

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
  }
}

/** The block at the heart of the bug: Moonshot ships `signature: ""`. */
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
  }
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
  }
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
  }
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

      // The turn TERMINATES (this is the property that hangs on moonshot).
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
    // The moonshot failure mode: content streams, then the iterator never
    // delivers `result` and never closes. Pre-fix `#drive` awaits forever.
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
 * `describe.skipIf(!process.env.X_API_KEY)` convention. Drives a real turn
 * against Moonshot's Anthropic-compatible endpoint and asserts it terminates.
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
