/**
 * Real-HTTP integration test for `POST /sessions/:id/chat` (http-server.ts).
 *
 * Unlike `chat-route.test.ts` (which replays the canonical fixture through the
 * pure `createTranscriptToUiMapper` in isolation, no socket), this boots a REAL
 * in-process runtime HTTP server via `startHttpServer`, seeds the registry with
 * a fake agent session whose `send()` yields a realistic RAW event sequence
 * (text-delta → tool-call → tool-result → turn-end), issues a REAL `fetch` to
 * `POST /sessions/:id/chat`, and reads the REAL streaming `ReadableStream` body.
 *
 * It then asserts the complete UI-message-stream chunk sequence the mapper
 * produces for those events — the same flattened shape `chat-route.test.ts`
 * asserts, but delivered over the real SSE wire (start → text-delta → text-end →
 * tool-input-available → tool-output-available → finish), not just "the HTTP
 * status is 200".
 *
 * Deterministic + CI-safe: zero real LLM, zero real daemon, ephemeral port (0),
 * isolated transcript dir under os.tmpdir(). Records are delivered to the chat
 * stream via the live transcript-writer subscriber (the route subscribes
 * synchronously right after enqueuePrompt's admission gate, before the
 * fire-and-forget turn loop writes any record), so no fixed port or disk
 * alignment is required.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionDescriptor,
} from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

/** Ephemeral port — `0` lets the OS pick, no fixed port hard-coded. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return { start() {}, stop() {}, async fireNow() {} }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

/**
 * A fake agent-cli session whose `send()` yields a realistic RAW event sequence
 * for one assistant turn: some text, a tool call that resolves, then a clean
 * turn-end — the same spirit as `talkingAgentSession()` in
 * agent-host-empty-turn.test.ts, extended with a tool round-trip.
 */
function scriptedChatAgentSession(): AgentSessionLike {
  return {
    sessionId: "scripted-chat-session",
    async *send(_message: unknown): AsyncIterable<AgentStreamEvent> {
      yield { kind: "text-delta", text: "Let me check the repo status.\n" }
      yield {
        kind: "tool-call",
        toolCallId: "call_integration_01",
        toolName: "bash",
        arguments: { command: "git status --short" },
      }
      yield {
        kind: "tool-result",
        toolCallId: "call_integration_01",
        result: { stdout: " M packages/runtime/src/chat-stream.ts\n", stderr: "", exitCode: 0 },
        isError: false,
      }
      yield { kind: "turn-end", reason: "turn-complete" }
    },
    async cancel() {},
    async close() {},
  }
}

/**
 * Parse an SSE body (newline-delimited `data:` frames) into the JSON payloads,
 * skipping comment lines (`: connected`) and the `data: [DONE]` terminator.
 * Mirrors how an `ai@6` `UIMessageStream` client consumes the wire.
 */
function parseSseJsonFrames(body: string): unknown[] {
  const chunks: unknown[] = []
  for (const frame of body.split(/\n\n/)) {
    for (const line of frame.split(/\n/)) {
      if (!line.startsWith("data:")) continue
      const payload = line.slice("data:".length).trim()
      if (!payload || payload === "[DONE]") continue
      chunks.push(JSON.parse(payload) as unknown)
    }
  }
  return chunks
}

describe("POST /sessions/:id/chat — real HTTP streaming of the UI message stream", () => {
  it("streams the mapper's chunk sequence for a scripted turn over a real fetch", async () => {
    const transcriptDir = await mkdtemp(join(tmpdir(), "wp-s1-chat-itest-"))
    const registry = createSessionsRegistry({ persist: false, transcriptDir })

    const desc: SessionDescriptor = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedChatAgentSession(),
      adapterSlug: "fake",
    })

    const resolveAgentAdapter: AgentAdapterResolver = async () => {
      throw new Error("resolveAgentAdapter is not exercised by this test")
    }
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })

    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "check the repo" }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1")

      // Read the REAL streaming body from the response's ReadableStream.
      const bodyText = await res.text()
      expect(bodyText).toContain("data: [DONE]")

      const chunks = parseSseJsonFrames(bodyText)
      const T1 = `${desc.id}::assistant-turn-1`
      expect(chunks).toEqual([
        { type: "text-start", id: T1 },
        { type: "text-delta", id: T1, delta: "Let me check the repo status.\n" },
        { type: "text-end", id: T1 },
        {
          type: "tool-input-available",
          toolCallId: "call_integration_01",
          toolName: "bash",
          input: { command: "git status --short" },
        },
        {
          type: "tool-output-available",
          toolCallId: "call_integration_01",
          output: { stdout: " M packages/runtime/src/chat-stream.ts\n", stderr: "", exitCode: 0 },
        },
        { type: "finish", finishReason: "stop" },
      ])
    } finally {
      await http.stop()
      registry.shutdown()
      await rm(transcriptDir, { recursive: true, force: true })
    }
  })

  it("rejects a missing prompt with 400 before opening any stream", async () => {
    const transcriptDir = await mkdtemp(join(tmpdir(), "wp-s1-chat-itest-"))
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scriptedChatAgentSession(),
      adapterSlug: "fake",
    })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      resolveAgentAdapter: async () => {
        throw new Error("unused")
      },
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "   " }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("missing_prompt")
    } finally {
      await http.stop()
      registry.shutdown()
      await rm(transcriptDir, { recursive: true, force: true })
    }
  })
})
