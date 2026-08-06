import { describe, it, expect, vi, beforeEach } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { AgentCliPrintConfig, StreamEvent } from "../../types.js"

// ---------------------------------------------------------------------------
// Mock node:child_process so createPrintSession spawns a fake child instead
// of exec'ing a real binary. Each spawn() call is captured (bin + argv) and
// a fresh fake child is handed back so a test can push JSONL lines onto its
// stdout and control its exit.
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

const spawnCalls: Array<{ bin: string; args: string[] }> = []
let lastChild: FakeChild | undefined

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  return child
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    spawnCalls.push({ bin, args })
    lastChild = makeFakeChild()
    return lastChild
  }),
}))

import { createPrintSession } from "../print-arm.js"

const MASTRACODE_PRINT_CONFIG: AgentCliPrintConfig = {
  prompt_flag: "--prompt",
  output_format: ["--output", "jsonl"],
  pre_prompt: [],
  resume: { flag: "--thread", kind: "value" },
  event_schema: "mastra-jsonl",
}

function feed(child: FakeChild, lines: Array<Record<string, unknown>>) {
  for (const line of lines) child.stdout.write(JSON.stringify(line) + "\n")
}

/** Ends stdout and fires the exit event on a later tick, mirroring a real
 *  child process (whose stream 'end' propagates before 'exit' fires). */
function finish(child: FakeChild, exitCode = 0) {
  child.stdout.end()
  setImmediate(() => child.emit("exit", exitCode))
}

async function collect(iterable: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = []
  for await (const evt of iterable) out.push(evt)
  return out
}

/** Yield the macrotask queue once (lets readline's flowing-mode 'line'
 *  handler drain whatever was just written to the fake child's stdout). */
function tick() {
  return new Promise<void>(resolve => setImmediate(resolve))
}

/** Poll until the stream's readable buffer is empty (readline has consumed
 *  every buffered line) or `maxTurns` macrotasks elapse. Returns whether it
 *  actually drained — false means the consumer stalled the pipe. */
async function waitForDrain(stream: PassThrough, maxTurns = 200) {
  for (let i = 0; i < maxTurns; i++) {
    if (stream.readableLength === 0) return true
    await tick()
  }
  return stream.readableLength === 0
}

beforeEach(() => {
  spawnCalls.length = 0
  lastChild = undefined
})

describe("createPrintSession — mastracode print config", () => {
  it("spawns with the CLI's real --output jsonl flag, not the Claude stream-json default", async () => {
    const session = createPrintSession({
      bin: "npx",
      baseArgs: ["-y", "mastracode"],
      cwd: "/tmp",
      env: {},
      printConfig: MASTRACODE_PRINT_CONFIG,
    })

    const pending = collect(session.send("hello"))
    // Two ticks: `wrapAgentCliSpawn` is async (PR 6b's config-file lookup) so
    // `send()` awaits it before calling `spawn()` — one extra microtask hop
    // beyond the pre-6b synchronous wrap.
    await Promise.resolve()
    await Promise.resolve()

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]?.args).toEqual(
      expect.arrayContaining(["--output", "jsonl"]),
    )
    expect(spawnCalls[0]?.args).not.toContain("--output-format")
    expect(spawnCalls[0]?.args).not.toContain("stream-json")

    feed(lastChild!, [
      { type: "agent_end", reason: "complete" },
      {
        type: "result",
        status: "completed",
        text: "ok",
        finishReason: "complete",
        threadId: "thread-1",
        exitCode: 0,
      },
    ])
    finish(lastChild!, 0)
    await pending
  })

  it("preserves embedded newlines (incl. blank lines) across message_update deltas byte-for-byte", async () => {
    const session = createPrintSession({
      bin: "npx",
      baseArgs: ["-y", "mastracode"],
      cwd: "/tmp",
      env: {},
      printConfig: MASTRACODE_PRINT_CONFIG,
    })

    const pending = collect(session.send("hello"))
    // Two ticks: `wrapAgentCliSpawn` is async (PR 6b's config-file lookup) so
    // `send()` awaits it before calling `spawn()` — one extra microtask hop
    // beyond the pre-6b synchronous wrap.
    await Promise.resolve()
    await Promise.resolve()

    // Mastracode streams the FULL accumulated text on each message_update —
    // simulate it growing word-by-word across a markdown reply with a
    // paragraph break (blank line) in the middle.
    const original = "## Done\n\nFirst paragraph.\n\nSecond paragraph, no trailing newline"
    const growthPoints = [10, 25, original.length]
    for (const cut of growthPoints) {
      const content = [{ type: "text", text: original.slice(0, cut) }]
      feed(lastChild!, [
        { type: "message_update", message: { role: "assistant", content } },
      ])
    }
    feed(lastChild!, [
      { type: "agent_end", reason: "complete" },
      {
        type: "result",
        status: "completed",
        text: original,
        finishReason: "complete",
        threadId: "thread-1",
        exitCode: 0,
      },
    ])
    finish(lastChild!, 0)
    const events = await pending

    const reconstructed = events
      .filter(e => e.kind === "text-delta")
      .map(e => (e as { text: string }).text)
      .join("")
    expect(reconstructed).toBe(original)
  })

  it("unwraps the `{ format: 2, parts: [...] }` content shape on message_update and message_end, still tracking lastTextLength across updates", async () => {
    const session = createPrintSession({
      bin: "npx",
      baseArgs: ["-y", "mastracode"],
      cwd: "/tmp",
      env: {},
      printConfig: MASTRACODE_PRINT_CONFIG,
    })

    const pending = collect(session.send("hello"))
    // Two ticks: `wrapAgentCliSpawn` is async (PR 6b's config-file lookup) so
    // `send()` awaits it before calling `spawn()` — one extra microtask hop
    // beyond the pre-6b synchronous wrap.
    await Promise.resolve()
    await Promise.resolve()

    // Current mastracode (--output jsonl) wraps content in an object with a
    // `parts` array instead of the flat block-array shape.
    feed(lastChild!, [
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: { format: 2, parts: [{ type: "text", text: "HARNESS" }] },
        },
      },
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: { format: 2, parts: [{ type: "text", text: "HARNESS OK" }] },
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: { format: 2, parts: [{ type: "text", text: "HARNESS OK" }] },
        },
      },
      { type: "agent_end", reason: "complete" },
      {
        type: "result",
        status: "completed",
        text: "HARNESS OK",
        finishReason: "complete",
        threadId: "thread-1",
        exitCode: 0,
      },
    ])
    finish(lastChild!, 0)
    const events = await pending

    const deltas = events
      .filter(e => e.kind === "text-delta")
      .map(e => (e as { text: string }).text)
    expect(deltas).toEqual(["HARNESS", " OK"])
    expect(deltas.join("")).toBe("HARNESS OK")
  })

  it("threads the mastra tool_start `args` field into the tool-call StreamEvent's arguments", async () => {
    const session = createPrintSession({
      bin: "npx",
      baseArgs: ["-y", "mastracode"],
      cwd: "/tmp",
      env: {},
      printConfig: MASTRACODE_PRINT_CONFIG,
    })

    const pending = collect(session.send("hello"))
    // Two ticks: `wrapAgentCliSpawn` is async (PR 6b's config-file lookup) so
    // `send()` awaits it before calling `spawn()` — one extra microtask hop
    // beyond the pre-6b synchronous wrap.
    await Promise.resolve()
    await Promise.resolve()

    feed(lastChild!, [
      {
        type: "tool_start",
        toolCallId: "toolu_1",
        toolName: "view",
        args: { path: "/tmp/foo.ts" },
      },
      { type: "agent_end", reason: "complete" },
      {
        type: "result",
        status: "completed",
        text: "ok",
        finishReason: "complete",
        threadId: "thread-1",
        exitCode: 0,
      },
    ])
    finish(lastChild!, 0)
    const events = await pending

    const toolCall = events.find(e => e.kind === "tool-call")
    expect(toolCall).toMatchObject({
      kind: "tool-call",
      toolCallId: "toolu_1",
      toolName: "view",
      arguments: { path: "/tmp/foo.ts" },
    })
  })

  it("maps mastracode's native usage_update event to a usage_update StreamEvent carrying tokens", async () => {
    const session = createPrintSession({
      bin: "npx",
      baseArgs: ["-y", "mastracode"],
      cwd: "/tmp",
      env: {},
      printConfig: MASTRACODE_PRINT_CONFIG,
    })

    const pending = collect(session.send("hello"))
    // Two ticks: `wrapAgentCliSpawn` is async (PR 6b's config-file lookup) so
    // `send()` awaits it before calling `spawn()` — one extra microtask hop
    // beyond the pre-6b synchronous wrap.
    await Promise.resolve()
    await Promise.resolve()

    // Mastra Code emits `{ type: "usage_update", usage: TokenUsage }` on each
    // model step-finish (cumulative). promptTokens → tokensIn,
    // completionTokens → tokensOut; last-write-wins on the descriptor.
    feed(lastChild!, [
      {
        type: "usage_update",
        usage: { promptTokens: 1200, completionTokens: 340, totalTokens: 1540 },
      },
      { type: "agent_end", reason: "complete" },
      {
        type: "result",
        status: "completed",
        text: "ok",
        finishReason: "complete",
        usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 },
        threadId: "thread-1",
        exitCode: 0,
      },
    ])
    finish(lastChild!, 0)
    const events = await pending

    const usage = events.find(e => e.kind === "usage_update")
    expect(usage).toMatchObject({
      kind: "usage_update",
      size: 0,
      used: 0,
      tokensIn: 1200,
      tokensOut: 340,
    })
    // No fabricated cost — mastracode's usage_update carries none.
    expect((usage as { cost?: unknown }).cost).toBeUndefined()
  })

  it("captures the thread id from the authoritative `result` line, not the incidental om_status event", async () => {
    const session = createPrintSession({
      bin: "npx",
      baseArgs: ["-y", "mastracode"],
      cwd: "/tmp",
      env: {},
      printConfig: MASTRACODE_PRINT_CONFIG,
    })

    const pending = collect(session.send("hello"))
    // Two ticks: `wrapAgentCliSpawn` is async (PR 6b's config-file lookup) so
    // `send()` awaits it before calling `spawn()` — one extra microtask hop
    // beyond the pre-6b synchronous wrap.
    await Promise.resolve()
    await Promise.resolve()

    // No om_status event at all — mirrors a run with Observational Memory
    // disabled, the exact scenario that used to leave sessionId empty.
    feed(lastChild!, [
      { type: "agent_start" },
      { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
      { type: "agent_end", reason: "complete" },
      {
        type: "result",
        status: "completed",
        text: "hi",
        finishReason: "complete",
        threadId: "thread-abc",
        exitCode: 0,
      },
    ])
    finish(lastChild!, 0)
    await pending

    expect(session.sessionId).toBe("thread-abc")
  })

  it("ignores an om_status threadId — result stays the sole source of truth", async () => {
    const session = createPrintSession({
      bin: "npx",
      baseArgs: ["-y", "mastracode"],
      cwd: "/tmp",
      env: {},
      printConfig: MASTRACODE_PRINT_CONFIG,
    })

    const pending = collect(session.send("hello"))
    // Two ticks: `wrapAgentCliSpawn` is async (PR 6b's config-file lookup) so
    // `send()` awaits it before calling `spawn()` — one extra microtask hop
    // beyond the pre-6b synchronous wrap.
    await Promise.resolve()
    await Promise.resolve()

    feed(lastChild!, [
      { type: "om_status", threadId: "stale-om-thread" },
      { type: "agent_end", reason: "complete" },
      {
        type: "result",
        status: "completed",
        text: "hi",
        finishReason: "complete",
        threadId: "thread-real",
        exitCode: 0,
      },
    ])
    finish(lastChild!, 0)
    await pending

    expect(session.sessionId).toBe("thread-real")
  })

  it("surfaces the result line's error for pre-flight failures that never streamed an agent_end/error event", async () => {
    const session = createPrintSession({
      bin: "npx",
      baseArgs: ["-y", "mastracode"],
      cwd: "/tmp",
      env: {},
      printConfig: MASTRACODE_PRINT_CONFIG,
    })

    const pending = collect(session.send("hello"))
    // Two ticks: `wrapAgentCliSpawn` is async (PR 6b's config-file lookup) so
    // `send()` awaits it before calling `spawn()` — one extra microtask hop
    // beyond the pre-6b synchronous wrap.
    await Promise.resolve()
    await Promise.resolve()

    // A bad --model resolves straight to `fail()` in mastracode's CLI —
    // no agent_start/agent_end ever streams, only the final result line.
    feed(lastChild!, [
      {
        type: "result",
        status: "error",
        text: "",
        finishReason: "error",
        threadId: "thread-preflight",
        error: { name: "Error", message: 'Unknown model: "bogus/model"' },
        exitCode: 1,
      },
    ])
    finish(lastChild!, 1)
    const events = await pending

    expect(session.sessionId).toBe("thread-preflight")
    const errorEvents = events.filter(e => e.kind === "error")
    expect(
      errorEvents.some(e => e.error.message === 'Unknown model: "bogus/model"'),
    ).toBe(true)
  })

  it("passes the pre-seeded resumeSessionId as --thread <id> on the very first spawn", async () => {
    const session = createPrintSession({
      bin: "npx",
      baseArgs: ["-y", "mastracode"],
      cwd: "/tmp",
      env: {},
      resumeSessionId: "existing-thread",
      printConfig: MASTRACODE_PRINT_CONFIG,
    })

    const pending = collect(session.send("continue please"))
    // Two ticks: `wrapAgentCliSpawn` is async (PR 6b's config-file lookup) so
    // `send()` awaits it before calling `spawn()` — one extra microtask hop
    // beyond the pre-6b synchronous wrap.
    await Promise.resolve()
    await Promise.resolve()

    const idx = spawnCalls[0]?.args.indexOf("--thread") ?? -1
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(spawnCalls[0]?.args[idx + 1]).toBe("existing-thread")

    feed(lastChild!, [
      { type: "agent_end", reason: "complete" },
      {
        type: "result",
        status: "completed",
        text: "ok",
        finishReason: "complete",
        threadId: "existing-thread",
        exitCode: 0,
      },
    ])
    finish(lastChild!, 0)
    await pending
  })

  it("drains a fast child's stdout independently of a slow downstream consumer — no stall, every event delivered in order", async () => {
    const session = createPrintSession({
      bin: "npx",
      baseArgs: ["-y", "mastracode"],
      cwd: "/tmp",
      env: {},
      printConfig: MASTRACODE_PRINT_CONFIG,
    })

    // Drive the stream by hand so we can hold the consumer still while the
    // child keeps producing — the exact shape of the ENOBUFS incident,
    // where the daemon's downstream (transcript + ring buffer + SSE) had
    // backpressured and stopped pulling.
    const iterator = session.send("hello")[Symbol.asyncIterator]()

    // First pull kicks the generator: spawns the child, wires readline.
    const firstPull = iterator.next()
    // Two ticks: `wrapAgentCliSpawn` is async (PR 6b's config-file lookup) so
    // `send()` awaits it before calling `spawn()` — one extra microtask hop
    // beyond the pre-6b synchronous wrap.
    await Promise.resolve()
    await Promise.resolve()
    expect(lastChild).toBeDefined()
    const child = lastChild!

    // Fast producer: a big burst of tool_start events (~140 KB, well over
    // a pipe's high-water mark — the regime where the old async-iterator
    // loop paused the stream and let the OS pipe fill until ENOBUFS).
    const N = 2000
    const produced: Array<Record<string, unknown>> = []
    for (let i = 0; i < N; i++) {
      produced.push({
        type: "tool_start",
        toolCallId: `t${i}`,
        toolName: "view",
        args: { i },
      })
    }
    feed(child, produced)

    // The strongest possible slow-consumer proof: the consumer has pulled
    // NOTHING yet (firstPull is still unawaited), yet the child's stdout is
    // fully drained. readline consumes the pipe in flowing mode regardless
    // of how far behind the consumer is. Under the old
    // `for await (const line of rl)` code this stalls — readline pauses the
    // stream at the suspended `yield`, so readableLength stays > 0 and, on a
    // real OS pipe, the child hits ENOBUFS.
    expect(await waitForDrain(child.stdout)).toBe(true)

    // Now let the producer finish and drain the queue. No crash, and every
    // produced event arrives exactly once, in order — nothing was dropped
    // while the consumer lagged the fully-buffered producer.
    finish(child, 0)

    const received: StreamEvent[] = []
    let result = await firstPull
    while (!result.done) {
      received.push(result.value)
      result = await iterator.next()
    }

    expect(received).toHaveLength(N)
    received.forEach((evt, i) => {
      expect(evt.kind).toBe("tool-call")
      if (evt.kind === "tool-call") {
        expect(evt.toolCallId).toBe(`t${i}`)
        expect(evt.arguments).toEqual({ i })
      }
    })
  })

  it("wires the thread id captured from turn 1's result into --thread on turn 2's spawn", async () => {
    const session = createPrintSession({
      bin: "npx",
      baseArgs: ["-y", "mastracode"],
      cwd: "/tmp",
      env: {},
      printConfig: MASTRACODE_PRINT_CONFIG,
    })

    // Turn 1: fresh spawn, no resume flag yet.
    const firstTurn = collect(session.send("first"))
    // Two ticks: `wrapAgentCliSpawn` is async (PR 6b's config-file lookup) so
    // `send()` awaits it before calling `spawn()` — one extra microtask hop
    // beyond the pre-6b synchronous wrap.
    await Promise.resolve()
    await Promise.resolve()
    expect(spawnCalls[0]?.args).not.toContain("--thread")
    feed(lastChild!, [
      { type: "agent_end", reason: "complete" },
      {
        type: "result",
        status: "completed",
        text: "ok",
        finishReason: "complete",
        threadId: "thread-from-turn-1",
        exitCode: 0,
      },
    ])
    finish(lastChild!, 0)
    await firstTurn
    expect(session.sessionId).toBe("thread-from-turn-1")

    // Turn 2: same session object, next spawn must resume the captured thread.
    const secondTurn = collect(session.send("second"))
    // Two ticks: `wrapAgentCliSpawn` is async (PR 6b's config-file lookup) so
    // `send()` awaits it before calling `spawn()` — one extra microtask hop
    // beyond the pre-6b synchronous wrap.
    await Promise.resolve()
    await Promise.resolve()
    const idx = spawnCalls[1]?.args.indexOf("--thread") ?? -1
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(spawnCalls[1]?.args[idx + 1]).toBe("thread-from-turn-1")

    feed(lastChild!, [
      { type: "agent_end", reason: "complete" },
      {
        type: "result",
        status: "completed",
        text: "ok",
        finishReason: "complete",
        threadId: "thread-from-turn-1",
        exitCode: 0,
      },
    ])
    finish(lastChild!, 0)
    await secondTurn
  })
})

// ─────────────────────────────────────────────────────────────────────
// Google Antigravity (`agy`) stream-json print config.
// Wire shapes verified against antigravity.google/docs/cli/headless: events
// are discriminated by an `event` field (init | step_update | result), the
// session id is a nested `conversation_id`, text streams as incremental
// `step_update.text_delta`, and a `tool` step's DONE carries the call + its
// result together in `tool_info`.
// ─────────────────────────────────────────────────────────────────────

const ANTIGRAVITY_PRINT_CONFIG: AgentCliPrintConfig = {
  prompt_flag: "-p",
  output_format: ["--output-format", "stream-json"],
  pre_prompt: [],
  resume: { flag: "--conversation", kind: "value" },
  event_schema: "antigravity-stream-json",
}

describe("createPrintSession — antigravity print config", () => {
  it("spawns with agy's --output-format stream-json, not the Claude --no-interactive default", async () => {
    const session = createPrintSession({
      bin: "agy",
      baseArgs: [],
      cwd: "/tmp",
      env: {},
      printConfig: ANTIGRAVITY_PRINT_CONFIG,
    })

    const pending = collect(session.send("hi"))
    await Promise.resolve()
    await Promise.resolve()

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]?.args).toEqual(
      expect.arrayContaining(["--output-format", "stream-json", "-p", "hi"]),
    )
    expect(spawnCalls[0]?.args).not.toContain("--no-interactive")

    feed(lastChild!, [
      {
        event: "init",
        conversation_id: "conv-1",
        init: { cwd: "/tmp", tools: ["run_command"], permission_mode: "request-review" },
      },
      {
        event: "result",
        result: { conversation_id: "conv-1", status: "SUCCESS", response: "ok" },
      },
    ])
    finish(lastChild!, 0)
    await pending
  })

  it("emits each step_update.text_delta fragment verbatim (fragments are incremental, not cumulative)", async () => {
    const session = createPrintSession({
      bin: "agy",
      baseArgs: [],
      cwd: "/tmp",
      env: {},
      printConfig: ANTIGRAVITY_PRINT_CONFIG,
    })

    const pending = collect(session.send("hi"))
    await Promise.resolve()
    await Promise.resolve()

    feed(lastChild!, [
      { event: "init", conversation_id: "c", init: {} },
      { event: "step_update", step_update: { conversation_id: "c", step_index: 0, state: "DONE", step_type: "user_input" } },
      { event: "step_update", step_update: { conversation_id: "c", step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "Git rebase " } },
      { event: "step_update", step_update: { conversation_id: "c", step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "rewrites history." } },
      { event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "Git rebase rewrites history." } },
    ])
    finish(lastChild!, 0)
    const events = await pending

    const reconstructed = events
      .filter(e => e.kind === "text-delta")
      .map(e => (e as { text: string }).text)
      .join("")
    expect(reconstructed).toBe("Git rebase rewrites history.")
  })

  it("fans a tool step's DONE out to a tool-call + tool-result pair correlated by step_index", async () => {
    const session = createPrintSession({
      bin: "agy",
      baseArgs: [],
      cwd: "/tmp",
      env: {},
      printConfig: ANTIGRAVITY_PRINT_CONFIG,
    })

    const pending = collect(session.send("run echo"))
    await Promise.resolve()
    await Promise.resolve()

    feed(lastChild!, [
      { event: "init", conversation_id: "c", init: {} },
      {
        event: "step_update",
        step_update: {
          conversation_id: "c",
          step_index: 4,
          state: "DONE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "echo hello_headless_demo" },
            output: "hello_headless_demo\r\n",
          },
        },
      },
      { event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "" } },
    ])
    finish(lastChild!, 0)
    const events = await pending

    const call = events.find(e => e.kind === "tool-call")
    const result = events.find(e => e.kind === "tool-result")
    expect(call).toMatchObject({
      kind: "tool-call",
      toolCallId: "step-4",
      toolName: "run_command",
      arguments: { CommandLine: "echo hello_headless_demo" },
    })
    expect(result).toMatchObject({
      kind: "tool-result",
      toolCallId: "step-4",
      result: "hello_headless_demo\r\n",
      isError: false,
    })
  })

  it("marks a tool step with tool_info.error as an errored tool-result", async () => {
    const session = createPrintSession({
      bin: "agy",
      baseArgs: [],
      cwd: "/tmp",
      env: {},
      printConfig: ANTIGRAVITY_PRINT_CONFIG,
    })

    const pending = collect(session.send("bad tool"))
    await Promise.resolve()
    await Promise.resolve()

    feed(lastChild!, [
      { event: "init", conversation_id: "c", init: {} },
      {
        event: "step_update",
        step_update: {
          conversation_id: "c",
          step_index: 2,
          state: "DONE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "false" },
            error: { type: "NonZeroExit", message: "command failed" },
          },
        },
      },
      { event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "" } },
    ])
    finish(lastChild!, 0)
    const events = await pending

    const result = events.find(e => e.kind === "tool-result")
    expect(result).toMatchObject({ kind: "tool-result", isError: true, result: "command failed" })
  })

  it("emits a usage_update and a completed turn-end from the terminal SUCCESS result", async () => {
    const session = createPrintSession({
      bin: "agy",
      baseArgs: [],
      cwd: "/tmp",
      env: {},
      printConfig: ANTIGRAVITY_PRINT_CONFIG,
    })

    const pending = collect(session.send("hi"))
    await Promise.resolve()
    await Promise.resolve()

    feed(lastChild!, [
      { event: "init", conversation_id: "c", init: {} },
      {
        event: "result",
        result: {
          conversation_id: "c",
          status: "SUCCESS",
          response: "done",
          usage: { input_tokens: 10418, output_tokens: 589, total_tokens: 11007 },
        },
      },
    ])
    finish(lastChild!, 0)
    const events = await pending

    const usage = events.find(e => e.kind === "usage_update")
    expect(usage).toMatchObject({ kind: "usage_update", tokensIn: 10418, tokensOut: 589 })
    const turnEnd = events.find(e => e.kind === "turn-end")
    expect(turnEnd).toMatchObject({ kind: "turn-end", reason: "completed" })
  })

  it("surfaces an ERROR-status result (e.g. unknown --model) as an error event, not a turn-end", async () => {
    const session = createPrintSession({
      bin: "agy",
      baseArgs: [],
      cwd: "/tmp",
      env: {},
      printConfig: ANTIGRAVITY_PRINT_CONFIG,
    })

    const pending = collect(session.send("hi"))
    await Promise.resolve()
    await Promise.resolve()

    feed(lastChild!, [
      {
        event: "result",
        result: {
          conversation_id: "",
          status: "ERROR",
          response: "",
          error: "invalid model selection",
        },
      },
    ])
    finish(lastChild!, 1)
    const events = await pending

    const err = events.find(e => e.kind === "error")
    expect(err).toMatchObject({ kind: "error", error: { message: "invalid model selection" } })
    expect(events.find(e => e.kind === "turn-end")).toBeUndefined()
  })

  it("captures conversation_id from init and resumes it via --conversation on turn 2", async () => {
    const session = createPrintSession({
      bin: "agy",
      baseArgs: [],
      cwd: "/tmp",
      env: {},
      printConfig: ANTIGRAVITY_PRINT_CONFIG,
    })

    const firstTurn = collect(session.send("first"))
    await Promise.resolve()
    await Promise.resolve()
    expect(spawnCalls[0]?.args).not.toContain("--conversation")

    feed(lastChild!, [
      { event: "init", conversation_id: "conv-abc", init: {} },
      { event: "result", result: { conversation_id: "conv-abc", status: "SUCCESS", response: "ok" } },
    ])
    finish(lastChild!, 0)
    await firstTurn
    expect(session.sessionId).toBe("conv-abc")

    const secondTurn = collect(session.send("second"))
    await Promise.resolve()
    await Promise.resolve()
    const idx = spawnCalls[1]?.args.indexOf("--conversation") ?? -1
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(spawnCalls[1]?.args[idx + 1]).toBe("conv-abc")

    feed(lastChild!, [
      { event: "result", result: { conversation_id: "conv-abc", status: "SUCCESS", response: "ok" } },
    ])
    finish(lastChild!, 0)
    await secondTurn
  })
})
