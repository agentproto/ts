import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { listDesktopConversations } from "../desktop-conversations.js"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desktop-conv-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function claudeFile(name: string, body: unknown) {
  const dir = join(root, "claude", "acct", "org")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), typeof body === "string" ? body : JSON.stringify(body))
}

function codexDb(rows: Array<Record<string, unknown>>) {
  const dir = join(root, "codex")
  return mkdir(dir, { recursive: true }).then(() => {
    const db = new DatabaseSync(join(dir, "state_5.sqlite"))
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, name TEXT, " +
        "archived INTEGER, created_at INTEGER, updated_at INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)",
    )
    const ins = db.prepare(
      "INSERT INTO threads VALUES (:id,:rollout_path,:cwd,:title,:name,:archived,:created_at,:updated_at,:created_at_ms,:updated_at_ms)",
    )
    for (const r of rows) {
      ins.run({ rollout_path: null, cwd: null, name: null, archived: 0, created_at: 1, created_at_ms: null, updated_at_ms: null, ...r } as any)
    }
    db.close()
  })
}

const opts = () => ({ claudeSessionsDir: join(root, "claude"), codexHome: join(root, "codex") })

describe("listDesktopConversations", () => {
  it("lists both apps newest first with their daemon addresses", async () => {
    await claudeFile("local_a.json", { sessionId: "local_a", cliSessionId: "cli-a", title: "Plan A", cwd: "/x", lastActivityAt: 3_000, createdAt: 1_000 })
    await codexDb([
      { id: "t1", title: "first msg", name: "Mon chat", updated_at: 5, rollout_path: "/r/t1.jsonl", cwd: "/y" },
      { id: "t2", title: "old", updated_at: 1 },
    ])
    const out = await listDesktopConversations(opts())
    expect(out.map(c => c.externalId)).toEqual(["codex:t1", "cc:cli-a", "codex:t2"])
    expect(out[0]).toMatchObject({ app: "codex", title: "Mon chat", transcriptPath: "/r/t1.jsonl", lastActivityMs: 5000 })
    expect(out[1]).toMatchObject({ app: "claude", id: "cli-a", title: "Plan A", appSessionId: "local_a" })
  })

  it("hides archived chats unless asked, and filters by app", async () => {
    await claudeFile("local_a.json", { cliSessionId: "cli-a", isArchived: true, title: "gone" })
    await claudeFile("local_b.json", { cliSessionId: "cli-b", title: "kept" })
    expect((await listDesktopConversations(opts())).map(c => c.id)).toEqual(["cli-b"])
    expect((await listDesktopConversations({ ...opts(), includeArchived: true })).map(c => c.id).sort()).toEqual(["cli-a", "cli-b"])
    expect(await listDesktopConversations({ ...opts(), app: "codex" })).toEqual([])
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
    expect(await listDesktopConversations({ ...opts(), app: "codex" })).toEqual([])
  })

  it("caps the list at limit", async () => {
    for (let i = 0; i < 4; i++) await claudeFile(`local_${i}.json`, { cliSessionId: `c${i}`, lastActivityAt: i })
    expect((await listDesktopConversations({ ...opts(), limit: 2 })).map(c => c.id)).toEqual(["c3", "c2"])
  })
})
