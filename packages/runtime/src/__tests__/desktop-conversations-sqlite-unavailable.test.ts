import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// node:sqlite does not exist before Node 22.5. Simulate that: importing it throws.
vi.mock("node:sqlite", () => {
  throw new Error("ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite")
})

import { listDesktopConversations } from "../desktop-conversations.js"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desktop-nosqlite-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("listDesktopConversations without node:sqlite", () => {
  it("still lists the Claude chats when the Codex half cannot open its database", async () => {
    const dir = join(root, "claude", "acct", "org")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "local_a.json"), JSON.stringify({ cliSessionId: "cli-a", title: "Chat A" }))
    // A codex db file must exist, otherwise the stat guard returns before the import.
    await mkdir(join(root, "codex"), { recursive: true })
    await writeFile(join(root, "codex", "state_5.sqlite"), "")
    const out = await listDesktopConversations({
      claudeSessionsDirs: [join(root, "claude")],
      codexHome: join(root, "codex"),
    })
    expect(out.map(c => c.externalId)).toEqual(["cc:cli-a"])
  })
})
