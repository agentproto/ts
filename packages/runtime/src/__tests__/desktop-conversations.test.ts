import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  askDesktopConversation,
  listDesktopConversations,
  readDesktopConversation,
  registerDesktopConversationAskTool,
  registerDesktopConversationListTool,
} from "../desktop-conversations.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerMessageTools } from "../message-tools.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"
import { claudeCodeProjectDir } from "../conversation-store.js"

// Record every claudeCodeProjectDir() call so a test can assert that a Codex
// chat never reaches for the `~/.claude/projects/...` path.
const { projectDirCalls } = vi.hoisted(() => ({ projectDirCalls: [] as string[] }))
vi.mock("../conversation-store.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../conversation-store.js")>()
  return {
    ...actual,
    claudeCodeProjectDir: (cwd: string, configDir?: string) => {
      projectDirCalls.push(cwd)
      return actual.claudeCodeProjectDir(cwd, configDir)
    },
  }
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desktop-conv-"))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function claudeFile(name: string, body: unknown) {
  const dir = join(root, "claude", "acct", "org")
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, name),
    typeof body === "string" ? body : JSON.stringify(body)
  )
}

function codexDb(
  rows: Array<Record<string, unknown>>,
  dir = join(root, "codex")
) {
  return mkdir(dir, { recursive: true }).then(() => {
    const db = new DatabaseSync(join(dir, "state_5.sqlite"))
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, name TEXT, " +
        "archived INTEGER, created_at INTEGER, updated_at INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)"
    )
    const ins = db.prepare(
      "INSERT INTO threads VALUES (:id,:rollout_path,:cwd,:title,:name,:archived,:created_at,:updated_at,:created_at_ms,:updated_at_ms)"
    )
    for (const r of rows) {
      ins.run({
        rollout_path: null,
        cwd: null,
        name: null,
        archived: 0,
        created_at: 1,
        created_at_ms: null,
        updated_at_ms: null,
        ...r,
      } as any)
    }
    db.close()
  })
}

const opts = () => ({
  claudeSessionsDirs: [join(root, "claude"), join(root, "claude-3p")],
  codexHome: join(root, "codex"),
})

describe("listDesktopConversations", () => {
  it("lists both apps newest first with their daemon addresses", async () => {
    await claudeFile("local_a.json", {
      sessionId: "local_a",
      cliSessionId: "cli-a",
      title: "Plan A",
      cwd: "/x",
      lastActivityAt: 3_000,
      createdAt: 1_000,
    })
    await codexDb([
      {
        id: "t1",
        title: "first msg",
        name: "Mon chat",
        updated_at: 5,
        rollout_path: "/r/t1.jsonl",
        cwd: "/y",
      },
      { id: "t2", title: "old", updated_at: 1 },
    ])
    const out = await listDesktopConversations(opts())
    expect(out.map(c => c.externalId)).toEqual([
      "codex:t1",
      "cc:cli-a",
      "codex:t2",
    ])
    expect(out[0]).toMatchObject({
      app: "codex",
      title: "Mon chat",
      transcriptPath: "/r/t1.jsonl",
      lastActivityMs: 5000,
    })
    expect(out[1]).toMatchObject({
      app: "claude",
      id: "cli-a",
      title: "Plan A",
      appSessionId: "local_a",
    })
  })

  it("hides archived chats unless asked, and filters by app", async () => {
    await claudeFile("local_a.json", {
      cliSessionId: "cli-a",
      isArchived: true,
      title: "gone",
    })
    await claudeFile("local_b.json", { cliSessionId: "cli-b", title: "kept" })
    expect((await listDesktopConversations(opts())).map(c => c.id)).toEqual([
      "cli-b",
    ])
    expect(
      (await listDesktopConversations({ ...opts(), includeArchived: true }))
        .map(c => c.id)
        .sort()
    ).toEqual(["cli-a", "cli-b"])
    expect(await listDesktopConversations({ ...opts(), app: "codex" })).toEqual(
      []
    )
  })

  it("skips broken files, chats without a CLI session, and a missing codex db", async () => {
    await claudeFile("local_bad.json", "{not json")
    await claudeFile("local_nocli.json", { title: "never ran" })
    await claudeFile("other.json", { cliSessionId: "ignored" })
    expect(await listDesktopConversations(opts())).toEqual([])
  })

  it("returns nothing for a codex db whose schema moved", async () => {
    await mkdir(join(root, "codex"), { recursive: true })
    const db = new DatabaseSync(join(root, "codex", "state_5.sqlite"))
    db.exec("CREATE TABLE threads (id TEXT)")
    db.close()
    expect(await listDesktopConversations({ ...opts(), app: "codex" })).toEqual(
      []
    )
  })

  it("merges the standard and 3p Claude folders, newest copy wins", async () => {
    await claudeFile("local_a.json", {
      cliSessionId: "same",
      title: "old",
      lastActivityAt: 1,
    })
    const dir3p = join(root, "claude-3p", "acct", "org")
    await mkdir(dir3p, { recursive: true })
    await writeFile(
      join(dir3p, "local_a.json"),
      JSON.stringify({ cliSessionId: "same", title: "new", lastActivityAt: 9 })
    )
    await writeFile(
      join(dir3p, "local_b.json"),
      JSON.stringify({ cliSessionId: "only3p", lastActivityAt: 2 })
    )
    const out = await listDesktopConversations({ ...opts(), app: "claude" })
    expect(out.map(c => [c.id, c.title])).toEqual([
      ["same", "new"],
      ["only3p", "(sans titre)"],
    ])
  })

  it("caps the list at limit", async () => {
    for (let i = 0; i < 4; i++)
      await claudeFile(`local_${i}.json`, {
        cliSessionId: `c${i}`,
        lastActivityAt: i,
      })
    expect(
      (await listDesktopConversations({ ...opts(), limit: 2 })).map(c => c.id)
    ).toEqual(["c3", "c2"])
  })

  it("finds a Claude title before applying the result limit", async () => {
    const home = join(root, "home")
    vi.stubEnv("HOME", home)
    vi.stubEnv("USERPROFILE", home)
    const dir = join(home, "Library", "Application Support", "Claude", "claude-code-sessions", "acct", "org")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "local_newer.json"), JSON.stringify({
      cliSessionId: "newer",
      title: "Unrelated",
      lastActivityAt: 2,
    }))
    await writeFile(join(dir, "local_match.json"), JSON.stringify({
      cliSessionId: "match",
      title: "Réunion produit",
      lastActivityAt: 1,
    }))
    const registry = createSessionsRegistry({ persist: false })
    registry.touchExternal({ id: "cc:newer", host: "claude-desktop" })
    const server = new McpServer({ name: "t", version: "0" })
    registerDesktopConversationListTool(server, registry)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "c", version: "0" })
    await client.connect(clientTransport)
    try {
      const list = async (onlyAlive = false) => {
        const result = await client.callTool({
          name: "desktop_conversation_list",
          arguments: { app: "claude", q: "  RÉUNION ", limit: 1, onlyAlive },
        }) as { content: Array<{ text: string }> }
        return JSON.parse(result.content[0]!.text)
      }
      const expected = {
        count: 1,
        conversations: [{ externalId: "cc:match", title: "Réunion produit" }],
      }
      expect(await list()).toMatchObject(expected)
      expect(await list(true)).toEqual({ count: 0, conversations: [] })
      registry.touchExternal({ id: "cc:match", host: "claude-desktop" })
      expect(await list(true)).toMatchObject(expected)
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe("readDesktopConversation", () => {
  it("reads the tail of a Claude chat from the jsonl under its cwd, and refuses an unlisted id", async () => {
    const cwd = join(root, "proj")
    await claudeFile("local_a.json", { cliSessionId: "cli-a", cwd, title: "T" })
    vi.stubEnv("HOME", join(root, "home"))
    // exportClaudeCodeSession reads <home>/.claude/projects/<cwd slug>/<id>.jsonl
    const slugDir = claudeCodeProjectDir(cwd)
    await mkdir(slugDir, { recursive: true })
    const line = (type: string, role: string, text: string, i: number) =>
      JSON.stringify({
        type,
        uuid: `u${i}`,
        timestamp: `2026-11-17T10:00:0${i}Z`,
        sessionId: "cli-a",
        message: { role, content: text },
      })
    await writeFile(
      join(slugDir, "cli-a.jsonl"),
      [
        line("user", "user", "un", 1),
        line("assistant", "assistant", "deux", 2),
        line("user", "user", "trois", 3),
      ].join("\n") + "\n"
    )
    const r = await readDesktopConversation({
      ...opts(),
      app: "claude",
      id: "cli-a",
      tail: 2,
    })
    expect(r.totalMessages).toBe(3)
    expect(r.messages.map(m => m.text)).toEqual(["deux", "trois"])
    await expect(
      readDesktopConversation({ ...opts(), app: "claude", id: "nope" })
    ).rejects.toThrow(/no claude Desktop conversation/)
    await expect(
      readDesktopConversation({ ...opts(), app: "codex", id: "cli-a" })
    ).rejects.toThrow(/no codex Desktop conversation/)
  })
})

describe("readDesktopConversation: cwd given through a symlink", () => {
  // macOS: `/tmp/x` is `/private/tmp/x`. The Desktop store keeps the cwd as the
  // user typed it, Claude Code names its projects/<slug> directory after the
  // resolved path, so the slug of the typed path never existed ("JSONL file not
  // found" on read and ask). Reproduced with a symlinked directory.
  async function symlinkedChat() {
    const realCwd = join(root, "real-proj")
    await mkdir(realCwd, { recursive: true })
    const linkCwd = join(root, "link-proj")
    await symlink(realCwd, linkCwd)
    await claudeFile("local_s.json", { cliSessionId: "cli-s", cwd: linkCwd, title: "S" })
    vi.stubEnv("HOME", join(root, "home"))
    // Claude Code wrote the transcript under the RESOLVED path's slug.
    const slugDir = claudeCodeProjectDir(await realpath(realCwd))
    await mkdir(slugDir, { recursive: true })
    await writeFile(
      join(slugDir, "cli-s.jsonl"),
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-11-17T10:00:01Z",
        sessionId: "cli-s",
        message: { role: "user", content: "bonjour" },
      }) + "\n"
    )
  }

  it("finds the transcript of a chat whose cwd is a symlink to the real directory", async () => {
    await symlinkedChat()
    const r = await readDesktopConversation({ ...opts(), app: "claude", id: "cli-s" })
    expect(r.messages.map(m => m.text)).toEqual(["bonjour"])
  })

  it("accepts the externalId the list shows (cc:<id>) as well as the bare id", async () => {
    await symlinkedChat()
    const r = await readDesktopConversation({ ...opts(), app: "claude", id: "cc:cli-s" })
    expect(r.conversation.id).toBe("cli-s")
    await expect(
      readDesktopConversation({ ...opts(), app: "codex", id: "cc:cli-s" })
    ).rejects.toThrow(/no codex Desktop conversation/)
  })
})

const toolOk = (body: Record<string, unknown>) => ({
  content: [
    { type: "text" as const, text: JSON.stringify({ ok: true, ...body }) },
  ],
})

describe("askDesktopConversation", () => {
  const cwd = () => join(root, "proj")
  const jl = (role: string, text: string, i: number) =>
    JSON.stringify({
      type: role,
      uuid: `u${i}`,
      timestamp: `2026-11-17T10:00:${String(i).padStart(2, "0")}Z`,
      sessionId: "cli-a",
      message: { role, content: text },
    }) + "\n"

  async function setup() {
    vi.stubEnv("HOME", join(root, "home"))
    await claudeFile("local_a.json", {
      sessionId: "local_a",
      cliSessionId: "cli-a",
      cwd: cwd(),
      title: "Chat A",
    })
    const dir = claudeCodeProjectDir(cwd())
    await mkdir(dir, { recursive: true })
    const file = join(dir, "cli-a.jsonl")
    await writeFile(file, jl("user", "avant", 1))
    return file
  }

  const fast = { pollMs: 10, settleMs: 30 }

  function fakeAgentSession(): AgentSessionLike {
    return {
      sessionId: "acp_test",
      // eslint-disable-next-line require-yield
      async *send(): AsyncIterable<AgentStreamEvent> {
        return
      },
      async cancel() {},
      async close() {},
    }
  }

  it("registers the chat, sends to its cc address and returns the answer the chat wrote", async () => {
    const file = await setup()
    const touchExternal = vi.fn()
    const sendMessage = vi.fn(async (_tool: string, to: string, msg: any) => {
      // the live chat answers after the wake
      setTimeout(
        () =>
          void appendFile(
            file,
            jl("user", msg.text, 2) + jl("assistant", "la réponse", 3)
          ),
        20
      )
      return toolOk({ messageId: "msg_1", to, delivered: { via: "socket" } })
    })
    const r = await askDesktopConversation({
      ...opts(),
      ...fast,
      registry: { touchExternal } as any,
      send: sendMessage as any,
      app: "claude",
      id: "cli-a",
      text: "ping",
      waitMs: 3000,
    })
    expect(touchExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cc:cli-a",
        host: "claude-desktop",
        hostSessionId: "local_a",
      })
    )
    expect(sendMessage.mock.calls[0]!.slice(0, 2)).toEqual([
      "desktop_conversation_ask",
      "cc:cli-a",
    ])
    expect(sendMessage.mock.calls[0]![2]).toMatchObject({
      text: "ping",
      kind: "question",
      urgency: "next-turn",
    })
    expect(r.reply).toBe("la réponse")
    expect(r.delivered).toEqual({ via: "socket" })
  })

  it("returns the answer even when the transcript ends on a system line, and when the turn adds over 200 messages", async () => {
    const file = await setup()
    const sendMessage = vi.fn(async (_t: string, to: string, msg: any) => {
      setTimeout(() => {
        const many = Array.from({ length: 230 }, (_, k) => jl("assistant", `part ${k}`, 10 + (k % 40))).join("")
        void appendFile(file, jl("user", msg.text, 2) + many + jl("system", "résumé", 59))
      }, 20)
      return toolOk({ messageId: "msg_s", to, delivered: { via: "socket" } })
    })
    const r = await askDesktopConversation({
      ...opts(),
      ...fast,
      registry: { touchExternal: vi.fn() } as any,
      send: sendMessage as any,
      app: "claude",
      id: "cli-a",
      text: "ping",
      waitMs: 3000,
    })
    // all 230 parts come back, not only the last 200
    expect(r.reply?.split("\n\n")).toHaveLength(230)
    expect(r.reply).toContain("part 0")
  })

  it("says so when the message is only parked in the inbox", async () => {
    await setup()
    const sendMessage = vi.fn(async () =>
      toolOk({ messageId: "msg_2", delivered: { via: "inbox" } })
    )
    const r = await askDesktopConversation({
      ...opts(),
      ...fast,
      registry: { touchExternal: vi.fn() } as any,
      send: sendMessage as any,
      app: "claude",
      id: "cli-a",
      text: "ping",
      waitMs: 150,
    })
    expect(r.reply).toBeNull()
    expect(r.note).toMatch(/parked in the chat's inbox/)
  })

  it("waitMs 0 only sends, and unknown ids are refused", async () => {
    await setup()
    const sendMessage = vi.fn(async () =>
      toolOk({ messageId: "msg_2", delivered: { via: "inbox" } })
    )
    const registry = { touchExternal: vi.fn() } as any
    const r = await askDesktopConversation({
      ...opts(),
      registry,
      send: sendMessage as any,
      app: "claude",
      id: "cli-a",
      text: "x",
      waitMs: 0,
    })
    expect(r.reply).toBeNull()
    await expect(
      askDesktopConversation({
        ...opts(),
        registry,
        send: sendMessage as any,
        app: "claude",
        id: "nope",
        text: "x",
      })
    ).rejects.toThrow(/no claude Desktop conversation/)
  })

  it("goes through message_send's own permission decision: a refusal sends nothing and is surfaced", async () => {
    await setup()
    const registry = createSessionsRegistry({ persist: false })
    // No caller identity and the default noCallerIdentity "block": message_send refuses.
    const { sendAsCaller } = registerMessageTools(
      new McpServer({ name: "t", version: "0" }),
      { registry }
    )
    await expect(
      askDesktopConversation({
        ...opts(),
        registry,
        send: sendAsCaller,
        app: "claude",
        id: "cli-a",
        text: "ping",
        waitMs: 0,
      })
    ).rejects.toThrow(
      /no_caller_identity|cannot identify the calling session|identity/i
    )
    expect(registry.get("cc:cli-a")?.kind).toBe("external")
    expect(registry.listInbox("cc:cli-a") ?? []).toEqual([])
  })

  it("delivers when the caller session is in the chat's own workspace", async () => {
    await setup()
    const registry = createSessionsRegistry({ persist: false })
    const caller = registry.spawnAgent({
      workspaceSlug: "ws-a",
      cwd: cwd(),
      agentSession: fakeAgentSession(),
      adapterSlug: "mock",
      label: "caller",
      depth: 0,
    })
    const sendMessage = vi.spyOn(registry, "sendMessage")
    const { sendAsCaller } = registerMessageTools(
      new McpServer({ name: "t", version: "0" }),
      { registry, callerSessionId: caller.id, workspaceOfCwd: () => "ws-a" }
    )
    const r = await askDesktopConversation({
      ...opts(),
      registry,
      send: sendAsCaller,
      workspaceOfCwd: () => "ws-a",
      app: "claude",
      id: "cli-a",
      text: "ping",
      waitMs: 0,
    })
    expect(r.reply).toBeNull()
    // The chat's external row carries the workspace resolved from its cwd, so
    // the default same-workspace allowance binds and the send goes through.
    expect(registry.get("cc:cli-a")?.workspaceSlug).toBe("ws-a")
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it("refuses with forbidden_recipient when the caller is outside the chat's workspace", async () => {
    await setup()
    const registry = createSessionsRegistry({ persist: false })
    const caller = registry.spawnAgent({
      workspaceSlug: "ws-b",
      cwd: cwd(),
      agentSession: fakeAgentSession(),
      adapterSlug: "mock",
      label: "caller",
      depth: 0,
    })
    const sendMessage = vi.spyOn(registry, "sendMessage")
    const { sendAsCaller } = registerMessageTools(
      new McpServer({ name: "t", version: "0" }),
      { registry, callerSessionId: caller.id, workspaceOfCwd: () => "ws-b" }
    )
    await expect(
      askDesktopConversation({
        ...opts(),
        registry,
        send: sendAsCaller,
        workspaceOfCwd: () => "ws-a",
        app: "claude",
        id: "cli-a",
        text: "ping",
        waitMs: 0,
      })
    ).rejects.toThrow(/forbidden_recipient|not a tree neighbour/)
    expect(registry.get("cc:cli-a")?.workspaceSlug).toBe("ws-a")
    expect(sendMessage).not.toHaveBeenCalled()
  })

  describe("codex", () => {
    const TID = "01a1eae5-a8d7-7230-8585-645615406614"
    const item = (role: string, text: string, i: number) =>
      JSON.stringify({
        timestamp: `2026-11-17T19:04:${String(i).padStart(2, "0")}.000Z`,
        ordinal: i,
        type: "response_item",
        payload: {
          type: "message",
          role,
          content: [{ type: role === "user" ? "input_text" : "output_text", text }],
        },
      }) + "\n"

    async function setupCodex() {
      const dir = join(root, "codex", "sessions", "2026", "11", "17")
      await mkdir(dir, { recursive: true })
      const file = join(dir, `rollout-2026-11-17T20-04-41-${TID}.jsonl`)
      await writeFile(
        file,
        JSON.stringify({ type: "session_meta", payload: { id: TID, session_id: TID, cwd: "/p" } }) + "\n" + item("user", "avant", 1)
      )
      await codexDb([{ id: TID, title: "t", name: "Mon thread", updated_at: 5, rollout_path: file, cwd: "/p" }])
      return file
    }

    it("registers the thread as a codex external row, sends next-turn, reports the wake and returns the answer", async () => {
      const file = await setupCodex()
      const touchExternal = vi.fn()
      const send = vi.fn(async (_t: string, _to: string, m: any) => {
        setTimeout(() => void appendFile(file, item("user", m.text, 2) + item("assistant", "réponse codex", 3)), 20)
        return toolOk({ messageId: "msg_c", delivered: { via: "inbox" }, desktopWake: "accepted" })
      })
      const r = await askDesktopConversation({
        ...opts(),
        pollMs: 10,
        settleMs: 30,
        registry: { touchExternal } as any,
        send: send as any,
        app: "codex",
        id: TID,
        text: "ping",
        waitMs: 3000,
      })
      expect(touchExternal).toHaveBeenCalledWith(expect.objectContaining({ id: `codex:${TID}`, host: "codex" }))
      expect(send.mock.calls[0]![1]).toBe(`codex:${TID}`)
      expect(send.mock.calls[0]![2]).toMatchObject({ urgency: "next-turn" })
      expect(r.desktopWake).toBe("accepted")
      expect(r.reply).toBe("réponse codex")
    })

    it("explains why nothing woke: not configured, wrong urgency, or a wake that said no", async () => {
      await setupCodex()
      const base = { ...opts(), pollMs: 10, settleMs: 30, registry: { touchExternal: vi.fn() } as any, app: "codex" as const, id: TID, text: "x", waitMs: 120 }
      const ask = (send: any, urgency?: "fyi" | "next-turn" | "steer") =>
        askDesktopConversation({ ...base, send, ...(urgency ? { urgency } : {}) })
      const parked = async () => toolOk({ messageId: "m", delivered: { via: "inbox" } })
      expect((await ask(parked)).note).toMatch(/not in daemon\.codexDesktopWakeThreadIds/)
      expect((await ask(parked, "steer")).note).toMatch(/only a next-turn message/)
      const refused = async () => toolOk({ messageId: "m", delivered: { via: "inbox" }, desktopWake: "unavailable" })
      expect((await ask(refused)).note).toMatch(/answered "unavailable"/)
    })

    it("does not fabricate a Claude transcript path for a Codex chat that has a cwd but no transcriptPath", async () => {
      // A Codex thread can carry a cwd and still have no rollout_path. The ask
      // loop must not fall back to `~/.claude/projects/<slug>/<id>.jsonl` for it.
      const dir = join(root, "codex", "sessions", "2026", "11", "17")
      await mkdir(dir, { recursive: true })
      const file = join(dir, `rollout-2026-11-17T20-04-41-${TID}.jsonl`)
      await writeFile(
        file,
        JSON.stringify({ type: "session_meta", payload: { id: TID, session_id: TID, cwd: "/p" } }) + "\n" + item("user", "avant", 1)
      )
      await codexDb([{ id: TID, title: "t", name: "Sans rollout", updated_at: 5, rollout_path: null, cwd: "/p" }])
      projectDirCalls.length = 0
      const send = vi.fn(async () => toolOk({ messageId: "m", delivered: { via: "inbox" } }))
      const r = await askDesktopConversation({
        ...opts(),
        pollMs: 10,
        settleMs: 20,
        registry: { touchExternal: vi.fn() } as any,
        send: send as any,
        app: "codex",
        id: TID,
        text: "ping",
        waitMs: 80,
      })
      expect(projectDirCalls).not.toContain("/p")
      expect(r.reply).toBeNull()
    })

    it("the registered MCP tool accepts app codex (schema reachability)", async () => {
      const home = join(root, "home")
      vi.stubEnv("HOME", home)
      const cdir = join(home, ".codex")
      await mkdir(join(cdir, "sessions"), { recursive: true })
      const file = join(cdir, "sessions", `rollout-${TID}.jsonl`)
      await writeFile(
        file,
        JSON.stringify({ type: "session_meta", payload: { id: TID, session_id: TID, cwd: "/p" } }) + "\n" + item("user", "avant", 1)
      )
      await codexDb([{ id: TID, title: "t", name: "Mon thread", updated_at: 5, rollout_path: file, cwd: "/p" }], cdir)
      const send = vi.fn(async () =>
        toolOk({ messageId: "m", delivered: { via: "inbox" }, desktopWake: "accepted" })
      )
      const server = new McpServer({ name: "desktop-ask-test", version: "0.0.0" })
      registerDesktopConversationAskTool(server, {
        registry: { touchExternal: vi.fn() } as any,
        send: send as any,
      })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new Client({ name: "test", version: "0.0.0" })
      await client.connect(clientTransport)
      try {
        const result = (await client.callTool({
          name: "desktop_conversation_ask",
          arguments: { app: "codex", id: TID, text: "ping", waitMs: 0 },
        })) as { isError?: boolean; content: Array<{ text: string }> }
        expect(result.isError).toBeFalsy()
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({
          desktopWake: "accepted",
          reply: null,
        })
        // Still a closed set: an unknown app is refused at the schema.
        const refused = (await client.callTool({
          name: "desktop_conversation_ask",
          arguments: { app: "gemini", id: TID, text: "ping", waitMs: 0 },
        })) as { isError?: boolean; content: Array<{ text: string }> }
        expect(refused.isError).toBe(true)
        expect(refused.content[0]!.text).toMatch(/expected one of "claude"\|"codex"/)
      } finally {
        await client.close()
        await server.close()
      }
    })
  })
})
