import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  askDesktopConversation,
  listDesktopConversations,
  readDesktopConversation,
} from "../desktop-conversations.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerMessageTools } from "../message-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { claudeCodeProjectDir } from "../conversation-store.js"

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

function codexDb(rows: Array<Record<string, unknown>>) {
  const dir = join(root, "codex")
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

  it("waitMs 0 only sends, and codex is refused for now", async () => {
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
        app: "codex",
        id: "t",
        text: "x",
      })
    ).rejects.toThrow(/only Claude Desktop/)
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
})
