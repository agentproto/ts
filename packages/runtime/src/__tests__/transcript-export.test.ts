/**
 * Tests for transcript-export.ts — no real sessions needed.
 * Fixtures are created in OS tmp dirs and the homedir() is mocked so the
 * exporters look inside the tmp tree rather than ~/.claude / ~/.hermes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import * as os from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  renderMarkdown,
  renderJson,
  exportAgentSession,
  crossValidateHermesExport,
  type ExportedSession,
} from "../transcript-export.js"
import type { SessionsRegistry } from "../sessions.js"

// Replace node:os.homedir with a vi.fn() so individual tests can
// inject their own tmp dir. The rest of the module is unchanged.
vi.mock("node:os", async importOriginal => {
  const orig = await importOriginal<typeof import("node:os")>()
  return { ...orig, homedir: vi.fn(() => orig.homedir()) }
})


// ── renderMarkdown ────────────────────────────────────────────────────

describe("renderMarkdown", () => {
  it("renders meta table and role-labelled messages", () => {
    const session: ExportedSession = {
      meta: {
        title: "Test Session",
        model: "claude-opus-4",
        startedAt: "2026-06-01 10:00:00",
        endedAt: "2026-06-01 10:05:00",
        messageCount: 2,
        toolCallCount: 1,
        costUsd: 0.0042,
        source: "claude-code",
      },
      messages: [
        { role: "user", text: "What is the capital of France?" },
        { role: "assistant", text: "Paris." },
      ],
    }
    const md = renderMarkdown(session)
    expect(md).toContain("# Test Session")
    expect(md).toContain("| Model | `claude-opus-4` |")
    expect(md).toContain("2026-06-01 10:00:00 → 2026-06-01 10:05:00")
    expect(md).toContain("$0.0042")
    expect(md).toContain("🧑 User")
    expect(md).toContain("What is the capital of France?")
    expect(md).toContain("🤖 Assistant")
    expect(md).toContain("Paris.")
  })

  it("appends origin/caller provenance to the source line when present", () => {
    const session: ExportedSession = {
      meta: { source: "daemon-events", origin: "cron", callerSessionId: "sess_deadbeef" },
      messages: [],
    }
    const md = renderMarkdown(session)
    expect(md).toContain("> Session · source `daemon-events` · origin `cron` · caller `sess_deadbeef`")
  })

  it("renders tool calls as blockquotes", () => {
    const session: ExportedSession = {
      meta: {},
      messages: [
        {
          role: "assistant",
          toolCalls: [{ name: "bash", args: '{"command":"ls -la"}' }],
        },
      ],
    }
    const md = renderMarkdown(session)
    expect(md).toContain("> 📞 bash ls -la")
  })

  it("wraps tool role output in a code block with tool name suffix", () => {
    const session: ExportedSession = {
      meta: {},
      messages: [{ role: "tool", toolName: "bash", text: "file1.txt\nfile2.txt" }],
    }
    const md = renderMarkdown(session)
    expect(md).toContain("🔧 Tool · `bash`")
    expect(md).toContain("```")
    expect(md).toContain("file1.txt")
  })

  it("truncates tool output at maxToolChars", () => {
    const longOutput = "x".repeat(2000)
    const session: ExportedSession = {
      meta: {},
      messages: [{ role: "tool", text: longOutput }],
    }
    const md = renderMarkdown(session, { maxToolChars: 100 })
    expect(md).toContain("chars truncated")
  })

  it("renders reasoning in a details/summary block", () => {
    const session: ExportedSession = {
      meta: {},
      messages: [
        {
          role: "assistant",
          reasoning: "I should think carefully.",
          text: "My answer.",
        },
      ],
    }
    const md = renderMarkdown(session)
    expect(md).toContain("<details>")
    expect(md).toContain("💭 reasoning")
    expect(md).toContain("I should think carefully.")
    expect(md).toContain("My answer.")
  })

  it("renders token counts in the meta table", () => {
    const session: ExportedSession = {
      meta: {
        tokens: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, reasoning: 30 },
      },
      messages: [],
    }
    const md = renderMarkdown(session)
    expect(md).toContain("| Tokens |")
    expect(md).toContain("in 1,000")
    expect(md).toContain("out 200")
    expect(md).toContain("cache r/w 50/10")
    expect(md).toContain("reason. 30")
  })
})

// ── renderJson ────────────────────────────────────────────────────────

describe("renderJson", () => {
  it("serialises to pretty-printed JSON", () => {
    const session: ExportedSession = {
      meta: { title: "hello" },
      messages: [{ role: "user", text: "world" }],
    }
    const parsed = JSON.parse(renderJson(session)) as ExportedSession
    expect(parsed.meta.title).toBe("hello")
    expect(parsed.messages[0]?.text).toBe("world")
  })
})

// ── claude-code JSONL exporter ────────────────────────────────────────

describe("claude-code JSONL exporter", () => {
  const CWD = "/test/project"
  const ENCODED = CWD.replace(/\//g, "-")
  const SESSION_ID = "abc12345-0000-0000-0000-000000000001"
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cc-export-"))
    mkdirSync(join(tmp, ".claude", "projects", ENCODED), { recursive: true })
    vi.mocked(os.homedir).mockReturnValue(tmp)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function writeJsonl(lines: object[]): void {
    writeFileSync(
      join(tmp, ".claude", "projects", ENCODED, `${SESSION_ID}.jsonl`),
      lines.map(l => JSON.stringify(l)).join("\n") + "\n",
    )
  }

  function makeRegistry(): SessionsRegistry {
    return {
      findByIdOrName: vi.fn().mockReturnValue({
        id: "sess_test1",
        kind: "agent-cli",
        workspaceSlug: "default",
        command: "claude",
        pid: null,
        status: "exited",
        startedAt: "2026-06-01T00:00:00Z",
        adapterSlug: "claude-code",
        adapterSessionId: SESSION_ID,
        cwd: CWD,
      }),
    } as unknown as SessionsRegistry
  }

  it("parses user → assistant+tool_use → tool_result → assistant flow", async () => {
    writeJsonl([
      { type: "ai-title" }, // noise — must be ignored
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "List files." }] },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", name: "bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "file1.txt\nfile2.txt" },
          ],
        },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "2 files found." }] },
      },
    ])

    const result = await exportAgentSession({ sessionId: "sess_test1", registry: makeRegistry() })

    expect(result.adapter).toBe("claude-code")
    expect(result.content).not.toContain("Error:")
    expect(result.content).toContain("🧑 User")
    expect(result.content).toContain("List files.")
    expect(result.content).toContain("🤖 Assistant")
    expect(result.content).toContain("Let me check.")
    expect(result.content).toContain("> 📞 bash ls")
    expect(result.content).toContain("🔧 Tool")
    expect(result.content).toContain("file1.txt")
    expect(result.content).toContain("2 files found.")
  })

  it("parses thinking blocks as reasoning in <details>", async () => {
    writeJsonl([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me reason carefully." },
            { type: "text", text: "Final answer." },
          ],
        },
      },
    ])

    const result = await exportAgentSession({ sessionId: "sess_test1", registry: makeRegistry() })

    expect(result.content).toContain("💭 reasoning")
    expect(result.content).toContain("Let me reason carefully.")
    expect(result.content).toContain("Final answer.")
  })

  it("returns an actionable error when JSONL file is missing", async () => {
    // no file written
    const result = await exportAgentSession({ sessionId: "sess_test1", registry: makeRegistry() })
    expect(result.content).toContain("Error:")
    expect(result.content).toContain("not found")
  })

  it("exports as JSON when format='json'", async () => {
    writeJsonl([
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ])

    const result = await exportAgentSession({
      sessionId: "sess_test1",
      registry: makeRegistry(),
      format: "json",
    })

    expect(result.format).toBe("json")
    const parsed = JSON.parse(result.content) as ExportedSession
    expect(parsed.messages[0]?.text).toBe("hi")
  })
})

// ── hermes SQLite exporter ────────────────────────────────────────────

describe("hermes SQLite exporter", () => {
  const SESSION_ID = "49f90943-dead-beef-0000-000000000001"
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hermes-export-"))
    mkdirSync(join(tmp, ".hermes"), { recursive: true })

    const db = new DatabaseSync(join(tmp, ".hermes", "state.db"))
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT, model TEXT,
        started_at INTEGER, ended_at INTEGER,
        message_count INTEGER, tool_call_count INTEGER, api_call_count INTEGER,
        input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        actual_cost_usd REAL, estimated_cost_usd REAL,
        cost_status TEXT, billing_provider TEXT, parent_session_id TEXT,
        end_reason TEXT, source TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT, tool_calls TEXT, tool_name TEXT,
        reasoning TEXT, reasoning_content TEXT,
        token_count INTEGER, timestamp INTEGER
      );
    `)
    db.prepare(
      `INSERT INTO sessions
         (id,title,model,started_at,ended_at,message_count,tool_call_count,
          api_call_count,input_tokens,output_tokens,cache_read_tokens,
          cache_write_tokens,reasoning_tokens,actual_cost_usd,source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      SESSION_ID,
      "My Test Session",
      "claude-opus-4-8",
      1748000000,
      1748001800,
      3, 1, 2,
      1500, 420, 200, 50, 80,
      0.0123,
      "acp",
    )
    db.prepare(
      `INSERT INTO messages (session_id,role,content,tool_calls,tool_name,reasoning,timestamp)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(SESSION_ID, "user", "Hello hermes!", null, null, null, 1748000100)
    db.prepare(
      `INSERT INTO messages (session_id,role,content,tool_calls,tool_name,reasoning,timestamp)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      SESSION_ID,
      "assistant",
      "Hi there! Let me check.",
      JSON.stringify([{ name: "bash", arguments: '{"command":"echo hi"}' }]),
      null,
      "I should be helpful.",
      1748000200,
    )
    db.prepare(
      `INSERT INTO messages (session_id,role,content,tool_calls,tool_name,reasoning,timestamp)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(SESSION_ID, "tool", "hi", null, "bash", null, 1748000300)
    db.close()

    vi.mocked(os.homedir).mockReturnValue(tmp)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function makeRegistry(): SessionsRegistry {
    return {
      findByIdOrName: vi.fn().mockReturnValue({
        id: "sess_h1",
        kind: "agent-cli",
        workspaceSlug: "default",
        command: "hermes",
        pid: null,
        status: "exited",
        startedAt: "2026-06-01T00:00:00Z",
        adapterSlug: "hermes",
        adapterSessionId: SESSION_ID,
        cwd: "/some/project",
      }),
    } as unknown as SessionsRegistry
  }

  it("exports as markdown with meta header and all message types", async () => {
    const result = await exportAgentSession({ sessionId: "sess_h1", registry: makeRegistry() })

    expect(result.adapter).toBe("hermes")
    expect(result.content).not.toContain("Error:")
    // meta
    expect(result.content).toContain("My Test Session")
    expect(result.content).toContain("`claude-opus-4-8`")
    expect(result.content).toContain("$0.0123")
    expect(result.content).toContain("source `acp`")
    // user turn
    expect(result.content).toContain("🧑 User")
    expect(result.content).toContain("Hello hermes!")
    // assistant with reasoning + tool call
    expect(result.content).toContain("🤖 Assistant")
    expect(result.content).toContain("Hi there!")
    expect(result.content).toContain("💭 reasoning")
    expect(result.content).toContain("I should be helpful.")
    expect(result.content).toContain("> 📞 bash echo hi")
    // tool result
    expect(result.content).toContain("🔧 Tool · `bash`")
    expect(result.content).toContain("hi")
    // meta object
    expect(result.meta.title).toBe("My Test Session")
    expect(result.meta.model).toBe("claude-opus-4-8")
    expect(result.meta.costUsd).toBeCloseTo(0.0123)
    expect(result.meta.source).toBe("acp")
    expect(result.meta.tokens?.input).toBe(1500)
    expect(result.meta.tokens?.reasoning).toBe(80)
  })

  it("exports as JSON with correct structure", async () => {
    const result = await exportAgentSession({
      sessionId: "sess_h1",
      registry: makeRegistry(),
      format: "json",
    })

    const parsed = JSON.parse(result.content) as ExportedSession
    expect(parsed.meta.title).toBe("My Test Session")
    expect(parsed.messages).toHaveLength(3)
    expect(parsed.messages[0]?.role).toBe("user")
    expect(parsed.messages[1]?.role).toBe("assistant")
    expect(parsed.messages[1]?.toolCalls?.[0]?.name).toBe("bash")
    expect(parsed.messages[1]?.reasoning).toBe("I should be helpful.")
    expect(parsed.messages[2]?.role).toBe("tool")
    expect(parsed.messages[2]?.toolName).toBe("bash")
  })

  it("returns an actionable error for an unknown session id", async () => {
    const result = await exportAgentSession({
      sessionId: "sess_h1",
      registry: {
        findByIdOrName: vi.fn().mockReturnValue({
          adapterSlug: "hermes",
          adapterSessionId: "does-not-exist",
          cwd: "/some/path",
        }),
      } as unknown as SessionsRegistry,
    })
    expect(result.content).toContain("Error:")
    expect(result.content).toContain("not found")
  })
})

// ── hermes cross-validation ───────────────────────────────────────────
//
// crossValidateHermesExport accepts an optional `_runner` parameter
// so tests can inject a mock instead of spawning a real subprocess.

describe("crossValidateHermesExport", () => {
  it("returns matched=true when binary count equals SQLite count", async () => {
    const jsonl = [
      '{"role":"user","content":"Hello"}',
      '{"role":"assistant","content":"Hi"}',
      '{"role":"tool","content":"result"}',
    ].join("\n")

    const result = await crossValidateHermesExport(
      "test-session-id",
      3,
      async () => jsonl,
    )
    expect(result).not.toBeNull()
    expect(result!.matched).toBe(true)
    expect(result!.sqliteCount).toBe(3)
    expect(result!.binaryCount).toBe(3)
  })

  it("returns matched=false and emits a console.warn when counts differ", async () => {
    const jsonl = [
      '{"role":"user","content":"Hello"}',
      '{"role":"assistant","content":"Hi"}',
    ].join("\n")

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await crossValidateHermesExport(
      "mismatch-session",
      3,
      async () => jsonl,
    )
    expect(result).not.toBeNull()
    expect(result!.matched).toBe(false)
    expect(result!.binaryCount).toBe(2)
    expect(result!.sqliteCount).toBe(3)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("mismatch"))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("SQLite=3"))

    warnSpy.mockRestore()
  })

  it("ignores non-message lines (no role field) in the binary output", async () => {
    const jsonl = [
      '{"type":"metadata","session_id":"abc"}', // no role — ignored
      '{"role":"user","content":"Hello"}',
      '{"role":"assistant","content":"Hi"}',
      "not valid json", // ignored
    ].join("\n")

    const result = await crossValidateHermesExport(
      "test-session-id",
      2,
      async () => jsonl,
    )
    expect(result!.binaryCount).toBe(2)
    expect(result!.matched).toBe(true)
  })

  it("returns binaryUnavailable=true when the runner throws ENOENT", async () => {
    const result = await crossValidateHermesExport(
      "test-session-id",
      5,
      async () => {
        const err = Object.assign(new Error("spawn hermes ENOENT"), { code: "ENOENT" })
        throw err
      },
    )
    expect(result).not.toBeNull()
    expect(result!.binaryUnavailable).toBe(true)
    // unavailable doesn't count as a mismatch
    expect(result!.matched).toBe(true)
  })

  it("returns null on unexpected runner errors (timeout, non-zero exit, etc.)", async () => {
    const result = await crossValidateHermesExport(
      "test-session-id",
      5,
      async () => {
        throw new Error("Process timed out after 10000ms")
      },
    )
    expect(result).toBeNull()
  })
})

// ── adapter dispatch ──────────────────────────────────────────────────

describe("adapter dispatch", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("routes to hermes exporter (fails with DB-missing error, not generic)", async () => {
    vi.mocked(os.homedir).mockReturnValue("/nonexistent-home-hermes")

    const result = await exportAgentSession({
      sessionId: "sess_d1",
      registry: {
        findByIdOrName: vi.fn().mockReturnValue({
          id: "sess_d1",
          adapterSlug: "hermes",
          adapterSessionId: "no-such-id",
          cwd: "/nonexistent",
        }),
      } as unknown as SessionsRegistry,
    })
    expect(result.adapter).toBe("hermes")
    expect(result.content).toContain("Error:")
    expect(result.content).toMatch(/state\.db not found|unavailable/)
  })

  it("routes to claude-code exporter (fails with JSONL-missing error)", async () => {
    vi.mocked(os.homedir).mockReturnValue("/nonexistent-home-cc")

    const result = await exportAgentSession({
      sessionId: "sess_d2",
      registry: {
        findByIdOrName: vi.fn().mockReturnValue({
          id: "sess_d2",
          adapterSlug: "claude-code",
          adapterSessionId: "no-such-file",
          cwd: "/nonexistent/path",
        }),
      } as unknown as SessionsRegistry,
    })
    expect(result.adapter).toBe("claude-code")
    expect(result.content).toContain("Error:")
    expect(result.content).toContain("JSONL file not found")
  })

  it("returns 'no exporter' error for an unsupported adapter", async () => {
    const result = await exportAgentSession({
      sessionId: "sess_d3",
      registry: {
        findByIdOrName: vi.fn().mockReturnValue({
          adapterSlug: "aider",
          adapterSessionId: "some-id",
          cwd: "/some/path",
        }),
      } as unknown as SessionsRegistry,
    })
    expect(result.adapter).toBe("aider")
    expect(result.content).toContain("Error:")
    expect(result.content).toContain("no exporter for adapter")
  })

  it("returns 'not found in registry' error when no descriptor and no override", async () => {
    const result = await exportAgentSession({
      sessionId: "sess_ghost",
      registry: {
        findByIdOrName: vi.fn().mockReturnValue(undefined),
      } as unknown as SessionsRegistry,
    })
    expect(result.content).toContain("Error:")
    expect(result.content).toContain("not found in registry")
  })
})

// ── daemon-events exporter (events.jsonl) ──────────────────────────────

describe("daemon-events exporter", () => {
  const SESSION_ID = "sess_x1"
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "daemon-export-"))
    vi.mocked(os.homedir).mockReturnValue(tmp)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function writeEvents(lines: object[]): void {
    const dir = join(tmp, ".agentproto", "sessions", SESSION_ID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "events.jsonl"),
      lines.map((l, i) => JSON.stringify({ seq: i + 1, ts: "2026-06-01T00:00:00.000Z", ...l })).join("\n") + "\n",
    )
  }

  function makeRegistry(desc: Record<string, unknown> = {}): SessionsRegistry {
    return {
      findByIdOrName: vi.fn().mockReturnValue({
        id: SESSION_ID,
        kind: "agent-cli",
        workspaceSlug: "default",
        command: "aider",
        pid: null,
        status: "exited",
        startedAt: "2026-06-01T00:00:00Z",
        adapterSlug: "aider", // no native exporter for this adapter
        ...desc,
      }),
    } as unknown as SessionsRegistry
  }

  it("reconstructs a user -> assistant+tool_call -> tool_result -> assistant flow", async () => {
    writeEvents([
      { kind: "user-prompt", sessionId: SESSION_ID, text: "List files." },
      { kind: "text-delta", sessionId: SESSION_ID, text: "Let me check." },
      {
        kind: "tool-call",
        sessionId: SESSION_ID,
        toolCallId: "t1",
        toolName: "bash",
        arguments: { command: "ls" },
      },
      {
        kind: "tool-result",
        sessionId: SESSION_ID,
        toolCallId: "t1",
        result: "file1.txt\nfile2.txt",
        isError: false,
      },
      { kind: "text-delta", sessionId: SESSION_ID, text: "2 files found." },
      { kind: "turn-end", sessionId: SESSION_ID, reason: "completed" },
    ])

    const result = await exportAgentSession({
      sessionId: SESSION_ID,
      registry: makeRegistry(),
      source: "daemon",
      format: "json",
    })

    expect(result.content).not.toContain("Error:")
    const parsed = JSON.parse(result.content) as ExportedSession
    expect(parsed.meta.source).toBe("daemon-events")
    const FIXTURE_TS = Date.parse("2026-06-01T00:00:00.000Z")
    expect(parsed.messages).toEqual([
      { role: "user", text: "List files.", ts: FIXTURE_TS },
      {
        role: "assistant",
        text: "Let me check.",
        toolCalls: [{ name: "bash", args: JSON.stringify({ command: "ls" }) }],
        ts: FIXTURE_TS,
      },
      { role: "tool", text: "file1.txt\nfile2.txt", toolName: "bash", ts: FIXTURE_TS },
      { role: "assistant", text: "2 files found.", ts: FIXTURE_TS },
    ])
  })

  it("maps a daemon-composed system-prompt record to a SYSTEM message, distinct from the caller's user-prompt", async () => {
    writeEvents([
      {
        kind: "system-prompt",
        sessionId: SESSION_ID,
        text: "You are the executor. Do the task yourself.",
      },
      { kind: "user-prompt", sessionId: SESSION_ID, text: "fix the bug" },
    ])

    const result = await exportAgentSession({
      sessionId: SESSION_ID,
      registry: makeRegistry(),
      source: "daemon",
      format: "json",
    })

    expect(result.content).not.toContain("Error:")
    const parsed = JSON.parse(result.content) as ExportedSession
    const FIXTURE_TS = Date.parse("2026-06-01T00:00:00.000Z")
    expect(parsed.messages).toEqual([
      { role: "system", text: "You are the executor. Do the task yourself.", ts: FIXTURE_TS },
      { role: "user", text: "fix the bug", ts: FIXTURE_TS },
    ])
  })

  it("renders plan and error events as system messages, and folds usage_update into meta", async () => {
    writeEvents([
      {
        kind: "plan",
        sessionId: SESSION_ID,
        entries: [
          { content: "step 1", priority: "high", status: "completed" },
          { content: "step 2", priority: "medium", status: "pending" },
        ],
      },
      {
        kind: "usage_update",
        sessionId: SESSION_ID,
        size: 100_000,
        used: 4_200,
        cost: { amount: 0.42, currency: "USD" },
      },
      { kind: "error", sessionId: SESSION_ID, error: { message: "boom" } },
    ])

    const result = await exportAgentSession({
      sessionId: SESSION_ID,
      registry: makeRegistry(),
      source: "daemon",
      format: "json",
    })

    const parsed = JSON.parse(result.content) as ExportedSession
    expect(parsed.messages).toContainEqual({ role: "system", text: "[plan] 1/2 step 1; step 2" })
    expect(parsed.messages).toContainEqual({ role: "system", text: "[error] boom" })
    expect(parsed.meta.costUsd).toBe(0.42)
  })

  it("enriches meta from the registry descriptor (model, label, cost, tokens)", async () => {
    writeEvents([{ kind: "user-prompt", sessionId: SESSION_ID, text: "hi" }])

    const result = await exportAgentSession({
      sessionId: SESSION_ID,
      registry: makeRegistry({
        label: "my-session",
        model: "claude-opus-4-8",
        costUsd: 1.23,
        tokensIn: 500,
        tokensOut: 200,
        startedAt: "2026-06-01T00:00:00Z",
        endedAt: "2026-06-01T00:05:00Z",
        origin: "cron",
        callerSessionId: "sess_deadbeef",
      }),
      source: "daemon",
      format: "json",
    })

    const parsed = JSON.parse(result.content) as ExportedSession
    expect(parsed.meta).toMatchObject({
      title: "my-session",
      model: "claude-opus-4-8",
      costUsd: 1.23,
      tokens: { input: 500, output: 200 },
      startedAt: "2026-06-01T00:00:00Z",
      endedAt: "2026-06-01T00:05:00Z",
      messageCount: 1,
      toolCallCount: 0,
      origin: "cron",
      callerSessionId: "sess_deadbeef",
    })
  })

  it("returns an actionable error when events.jsonl is missing (source='daemon')", async () => {
    const result = await exportAgentSession({
      sessionId: SESSION_ID,
      registry: makeRegistry(),
      source: "daemon",
    })
    expect(result.content).toContain("Error:")
    expect(result.content).toContain("no events.jsonl")
  })

  it("source='auto' falls back to daemon events when the adapter has no native exporter", async () => {
    writeEvents([{ kind: "user-prompt", sessionId: SESSION_ID, text: "hi via fallback" }])

    const result = await exportAgentSession({
      sessionId: SESSION_ID,
      registry: makeRegistry(),
      format: "json",
      // source omitted — defaults to "auto"
    })

    expect(result.content).not.toContain("Error:")
    expect(result.adapter).toBe("aider")
    const parsed = JSON.parse(result.content) as ExportedSession
    expect(parsed.meta.source).toBe("daemon-events")
    expect(parsed.messages[0]).toMatchObject({ role: "user", text: "hi via fallback" })
  })

  it("source='native' does NOT fall back to daemon events, even when events.jsonl exists", async () => {
    writeEvents([{ kind: "user-prompt", sessionId: SESSION_ID, text: "should not be read" }])

    const result = await exportAgentSession({
      sessionId: SESSION_ID,
      registry: makeRegistry(),
      source: "native",
    })

    expect(result.content).toContain("Error:")
    expect(result.content).toContain("no exporter for adapter")
    expect(result.content).not.toContain("daemon-events fallback")
  })
})
