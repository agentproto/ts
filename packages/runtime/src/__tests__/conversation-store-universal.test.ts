/**
 * Tests for the universal (any-harness) ConversationStore entries added
 * beyond claude-code/hermes: codex, opencode, mastracode-inprocess, pi.
 *
 * Each store is exercised through its public `CONVERSATION_STORES` entry
 * (discover + read) against a small on-disk fixture under a temp home /
 * env override — no live provider, no network. SQLite fixtures are built
 * with node:sqlite in write mode, then read back read-only exactly as the
 * production reader does.
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONVERSATION_STORES } from "../conversation-store.js"

// ── env sandbox helper ────────────────────────────────────────────────

const SAVED: Record<string, string | undefined> = {}
function setEnv(key: string, value: string): void {
  if (!(key in SAVED)) SAVED[key] = process.env[key]
  process.env[key] = value
}
let tmpRoots: string[] = []
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpRoots.push(d)
  return d
}

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
    delete SAVED[k]
  }
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true })
  tmpRoots = []
})

// ── registry shape ────────────────────────────────────────────────────

describe("CONVERSATION_STORES universal entries", () => {
  it("registers codex / opencode / mastracode-inprocess / pi with discover+read", () => {
    for (const key of ["codex", "opencode", "mastracode-inprocess", "pi"]) {
      const store = CONVERSATION_STORES[key]
      expect(store, key).toBeDefined()
      expect(store!.discover, key).toBeTypeOf("function")
      expect(store!.read, key).toBeTypeOf("function")
      expect(store!.storeAs, key).toBeTypeOf("string")
    }
  })
})

// ── codex ─────────────────────────────────────────────────────────────

describe("codex store", () => {
  const CWD = "/work/proj-a"
  const UUID = "019f7fc0-a324-7e40-b86d-fb9df6fcd385"

  function writeRollout(id: string, cwd: string, extra: object[] = []): void {
    const home = mkTmp("codex-home-")
    setEnv("CODEX_HOME", home)
    const dir = join(home, "sessions", "2026", "07", "20")
    mkdirSync(dir, { recursive: true })
    const lines = [
      { timestamp: "2026-07-20T13:39:19.095Z", type: "session_meta", payload: { id, timestamp: "2026-07-20T13:39:18.976Z", cwd } },
      ...extra,
    ]
    writeFileSync(
      join(dir, `rollout-2026-07-20T15-39-18-${id}.jsonl`),
      lines.map(l => JSON.stringify(l)).join("\n") + "\n",
    )
  }

  it("discover finds the rollout for a matching cwd", async () => {
    writeRollout(UUID, CWD)
    const found = await CONVERSATION_STORES["codex"]!.discover({ cwd: CWD })
    expect(found).toHaveLength(1)
    expect(found[0]?.conversationId).toBe(UUID)
    expect(found[0]?.startedAt).toBe("2026-07-20T13:39:18.976Z")
  })

  it("discover returns [] for a non-matching cwd", async () => {
    writeRollout(UUID, CWD)
    await expect(CONVERSATION_STORES["codex"]!.discover({ cwd: "/other" })).resolves.toEqual([])
  })

  it("discover exact-bind ignores cwd and binds the requested id", async () => {
    writeRollout(UUID, CWD)
    const found = await CONVERSATION_STORES["codex"]!.discover({ cwd: "/anything", expectedId: UUID })
    expect(found).toHaveLength(1)
    expect(found[0]?.conversationId).toBe(UUID)
  })

  it("read parses message / tool-call / tool-output and skips encrypted reasoning", async () => {
    writeRollout(UUID, CWD, [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi codex" }] } },
      { type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "OPAQUE_CIPHERTEXT" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: '{"cmd":"ls"}', call_id: "c1" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "file.txt" }] } },
    ])
    const session = await CONVERSATION_STORES["codex"]!.read(UUID, CWD)
    expect(session.meta.source).toBe("codex")
    expect(session.meta.toolCallCount).toBe(1)
    const roles = session.messages.map(m => m.role)
    expect(roles).toEqual(["user", "assistant", "assistant", "tool"])
    expect(session.messages[0]?.text).toBe("hi codex")
    expect(session.messages[2]?.toolCalls?.[0]).toEqual({ name: "exec", args: '{"cmd":"ls"}' })
    expect(session.messages[3]).toMatchObject({ role: "tool", text: "file.txt", toolName: "exec" })
    // The encrypted reasoning block must never surface as text/reasoning.
    expect(JSON.stringify(session)).not.toContain("OPAQUE_CIPHERTEXT")
  })

  it("read throws a clear error when the rollout is absent", async () => {
    writeRollout(UUID, CWD)
    await expect(CONVERSATION_STORES["codex"]!.read("nope-nope", CWD)).rejects.toThrow(/no rollout file/)
  })
})

// ── opencode ──────────────────────────────────────────────────────────

describe("opencode store", () => {
  const CWD = "/work/oc"
  const SID = "ses_08d70fae8ffewkfZY75uEJn005"

  function buildDb(sessionId: string, directory: string): void {
    const data = mkTmp("oc-data-")
    setEnv("XDG_DATA_HOME", data)
    const dir = join(data, "opencode")
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, "opencode.db"))
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
        model TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
        tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `)
    db.prepare(
      "INSERT INTO session (id,project_id,directory,title,model,cost,tokens_input,tokens_output,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(sessionId, "prj", directory, "My chat", JSON.stringify({ id: "gpt-5-mini", providerID: "openai" }), 0.01, 100, 20, 1784333449862, 1784333482750)
    db.prepare("INSERT INTO message (id,session_id,time_created,data) VALUES (?,?,?,?)").run(
      "msg_u", sessionId, 1784333449862, JSON.stringify({ role: "user" }),
    )
    db.prepare("INSERT INTO message (id,session_id,time_created,data) VALUES (?,?,?,?)").run(
      "msg_a", sessionId, 1784333449900, JSON.stringify({ role: "assistant" }),
    )
    db.prepare("INSERT INTO part (id,message_id,session_id,time_created,data) VALUES (?,?,?,?,?)").run(
      "p1", "msg_u", sessionId, 1784333449862, JSON.stringify({ type: "text", text: "install timeout?" }),
    )
    db.prepare("INSERT INTO part (id,message_id,session_id,time_created,data) VALUES (?,?,?,?,?)").run(
      "p2", "msg_a", sessionId, 1784333449900, JSON.stringify({ type: "reasoning", text: "thinking" }),
    )
    db.prepare("INSERT INTO part (id,message_id,session_id,time_created,data) VALUES (?,?,?,?,?)").run(
      "p3", "msg_a", sessionId, 1784333449901, JSON.stringify({ type: "text", text: "sure" }),
    )
    db.prepare("INSERT INTO part (id,message_id,session_id,time_created,data) VALUES (?,?,?,?,?)").run(
      "p4", "msg_a", sessionId, 1784333449902,
      JSON.stringify({ type: "tool", tool: "read", callID: "call1", state: { input: { filePath: "/x" }, output: "the contents" } }),
    )
    db.prepare("INSERT INTO part (id,message_id,session_id,time_created,data) VALUES (?,?,?,?,?)").run(
      "p5", "msg_a", sessionId, 1784333449903, JSON.stringify({ type: "step-finish" }),
    )
    db.close()
  }

  it("discover scopes by the session directory column", async () => {
    buildDb(SID, CWD)
    const found = await CONVERSATION_STORES["opencode"]!.discover({ cwd: CWD })
    expect(found.map(c => c.conversationId)).toEqual([SID])
    expect(found[0]?.preview).toBe("My chat")
    await expect(CONVERSATION_STORES["opencode"]!.discover({ cwd: "/nope" })).resolves.toEqual([])
  })

  it("discover returns [] (not a throw) when opencode.db is absent", async () => {
    setEnv("XDG_DATA_HOME", mkTmp("oc-empty-"))
    await expect(CONVERSATION_STORES["opencode"]!.discover({ cwd: CWD })).resolves.toEqual([])
  })

  it("read builds messages incl. tool call + separate tool result, plus meta", async () => {
    buildDb(SID, CWD)
    const session = await CONVERSATION_STORES["opencode"]!.read(SID)
    expect(session.meta.source).toBe("opencode")
    expect(session.meta.model).toBe("openai/gpt-5-mini")
    expect(session.meta.title).toBe("My chat")
    expect(session.meta.tokens).toMatchObject({ input: 100, output: 20 })
    expect(session.meta.costUsd).toBe(0.01)
    const roles = session.messages.map(m => m.role)
    expect(roles).toEqual(["user", "assistant", "tool"])
    const assistant = session.messages[1]!
    expect(assistant.text).toBe("sure")
    expect(assistant.reasoning).toBe("thinking")
    expect(assistant.toolCalls?.[0]).toEqual({ name: "read", args: JSON.stringify({ filePath: "/x" }) })
    expect(session.messages[2]).toMatchObject({ role: "tool", toolName: "read", text: "the contents" })
  })
})

// ── mastracode-inprocess ──────────────────────────────────────────────

describe("mastracode-inprocess store", () => {
  const RESOURCE = "agentproto-mastracode-inprocess-abc"
  const THREAD = "78333b17-24cc-49a4-8a56-c572d76da4db"
  const COMPOSITE = `${RESOURCE}:${THREAD}`

  function buildDb(): void {
    const home = mkTmp("agentproto-home-")
    setEnv("AGENTPROTO_HOME", home)
    const dir = join(home, "mastracode-inprocess")
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, "storage.db"))
    db.exec(`
      CREATE TABLE mastra_threads (id TEXT PRIMARY KEY, resourceId TEXT, title TEXT, metadata TEXT, createdAt TEXT, updatedAt TEXT);
      CREATE TABLE mastra_messages (id TEXT PRIMARY KEY, thread_id TEXT, content TEXT, role TEXT, type TEXT, createdAt TEXT, resourceId TEXT);
    `)
    db.prepare("INSERT INTO mastra_threads (id,resourceId,title,createdAt,updatedAt) VALUES (?,?,?,?,?)").run(
      THREAD, RESOURCE, "greet", "2026-07-02T03:25:30.000Z", "2026-07-02T03:26:00.000Z",
    )
    // user turn (Mastra tags user role as "signal")
    db.prepare("INSERT INTO mastra_messages (id,thread_id,content,role,type,createdAt) VALUES (?,?,?,?,?,?)").run(
      "m1", THREAD, JSON.stringify({ format: 2, parts: [{ type: "text", text: "say hi" }] }), "signal", "v2", "2026-07-02T03:25:30.100Z",
    )
    // assistant turn with reasoning + tool-invocation (call + result)
    db.prepare("INSERT INTO mastra_messages (id,thread_id,content,role,type,createdAt) VALUES (?,?,?,?,?,?)").run(
      "m2", THREAD,
      JSON.stringify({
        format: 2,
        parts: [
          { type: "data-om-status", data: { x: 1 } },
          { type: "reasoning", reasoning: "consider" },
          { type: "text", text: "hello!" },
          {
            type: "tool-invocation",
            toolInvocation: { state: "result", toolName: "agentproto_agent_start", args: { adapter: "claude-code" }, result: { content: [{ type: "text", text: "started" }] } },
          },
        ],
      }),
      "assistant", "v2", "2026-07-02T03:25:31.000Z",
    )
    db.close()
  }

  it("read splits the composite id and maps signal→user, tool-invocation→call+result", async () => {
    buildDb()
    const session = await CONVERSATION_STORES["mastracode-inprocess"]!.read(COMPOSITE)
    expect(session.meta.source).toBe("mastracode-inprocess")
    expect(session.meta.title).toBe("greet")
    expect(session.meta.toolCallCount).toBe(1)
    const roles = session.messages.map(m => m.role)
    expect(roles).toEqual(["user", "assistant", "tool"])
    expect(session.messages[0]?.text).toBe("say hi")
    expect(session.messages[1]?.text).toBe("hello!")
    expect(session.messages[1]?.reasoning).toBe("consider")
    expect(session.messages[1]?.toolCalls?.[0]?.name).toBe("agentproto_agent_start")
    expect(session.messages[2]).toMatchObject({ role: "tool", toolName: "agentproto_agent_start", text: "started" })
  })

  it("read tolerates a bare threadId (no resourceId prefix)", async () => {
    buildDb()
    const session = await CONVERSATION_STORES["mastracode-inprocess"]!.read(THREAD)
    expect(session.messages).toHaveLength(3)
  })

  it("discover is exact-bind only: id binds, no id returns []", async () => {
    buildDb()
    const bound = await CONVERSATION_STORES["mastracode-inprocess"]!.discover({ cwd: "/whatever", expectedId: COMPOSITE })
    expect(bound.map(c => c.conversationId)).toEqual([COMPOSITE])
    await expect(CONVERSATION_STORES["mastracode-inprocess"]!.discover({ cwd: "/whatever" })).resolves.toEqual([])
  })
})

// ── pi ────────────────────────────────────────────────────────────────

describe("pi store", () => {
  const CWD = "/work/pi-proj"
  const UUID = "019f818a-10db-7f81-b7f1-f9a78abe8129"

  function writeSession(id: string, cwd: string): void {
    const home = mkTmp("pi-home-")
    setEnv("HOME", home)
    const slug = `--${cwd.replace(/[^a-zA-Z0-9]/g, "-")}--`
    const dir = join(home, ".pi", "agent", "sessions", slug)
    mkdirSync(dir, { recursive: true })
    const lines = [
      { type: "session", version: 3, id, timestamp: "2026-07-20T21:58:56.987Z", cwd },
      { type: "model_change", id: "x", provider: "moonshotai", modelId: "kimi-k2.7-code" },
      { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "bonjour" }] } },
      {
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
            { type: "text", text: "salut" },
            { type: "toolCall", id: "t1", name: "read", arguments: { path: "x.md" } },
          ],
        },
      },
      { type: "message", id: "r1", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false } },
    ]
    writeFileSync(join(dir, `2026-07-20T21-58-56-987Z_${id}.jsonl`), lines.map(l => JSON.stringify(l)).join("\n") + "\n")
  }

  it("discover keys off the session-line cwd, not the dir slug", async () => {
    writeSession(UUID, CWD)
    const found = await CONVERSATION_STORES["pi"]!.discover({ cwd: CWD })
    expect(found.map(c => c.conversationId)).toEqual([UUID])
    await expect(CONVERSATION_STORES["pi"]!.discover({ cwd: "/other" })).resolves.toEqual([])
  })

  it("read maps user/assistant/toolResult and captures model + thinking", async () => {
    writeSession(UUID, CWD)
    const session = await CONVERSATION_STORES["pi"]!.read(UUID)
    expect(session.meta.source).toBe("pi")
    expect(session.meta.model).toBe("moonshotai/kimi-k2.7-code")
    expect(session.meta.toolCallCount).toBe(1)
    const roles = session.messages.map(m => m.role)
    expect(roles).toEqual(["user", "assistant", "tool"])
    expect(session.messages[0]?.text).toBe("bonjour")
    expect(session.messages[1]?.text).toBe("salut")
    expect(session.messages[1]?.reasoning).toBe("hmm")
    expect(session.messages[1]?.toolCalls?.[0]).toEqual({ name: "read", args: JSON.stringify({ path: "x.md" }) })
    expect(session.messages[2]).toMatchObject({ role: "tool", toolName: "read", text: "file body" })
  })

  it("read throws when no session file matches the id", async () => {
    writeSession(UUID, CWD)
    await expect(CONVERSATION_STORES["pi"]!.read("missing-id")).rejects.toThrow(/no session file/)
  })
})
