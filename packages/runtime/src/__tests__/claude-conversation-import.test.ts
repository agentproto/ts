import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { listClaudeConversationCandidates } from "../claude-conversation-import.js"

let fakeHome: string
let originalHome: string | undefined

afterEach(() => {
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
})

function setupProjectsRoot(): string {
  originalHome = process.env.HOME
  fakeHome = mkdtempSync(join(tmpdir(), "claude-import-"))
  process.env.HOME = fakeHome
  const root = join(fakeHome, ".claude", "projects")
  mkdirSync(root, { recursive: true })
  return root
}

function writeJsonl(path: string, lines: object[]): void {
  writeFileSync(path, `${lines.map(l => JSON.stringify(l)).join("\n")}\n`, "utf8")
}

describe("listClaudeConversationCandidates", () => {
  it("derives cwd from the first content line and ignores later cwd drift", async () => {
    const root = setupProjectsRoot()
    const dir = join(root, "launch")
    mkdirSync(dir, { recursive: true })
    writeJsonl(join(dir, "sess_1.jsonl"), [
      {
        type: "user",
        timestamp: "2026-07-19T09:00:00.000Z",
        cwd: "/Volumes/SSDExternalMacStudio/Code/_agentproto-worktrees/ts/term-conv-harmonize",
        message: { role: "user", content: [{ type: "text", text: "launch" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-07-19T09:05:00.000Z",
        cwd: "/tmp/elsewhere",
        message: { role: "assistant", content: [{ type: "text", text: "later" }] },
      },
    ])

    const [candidate] = await listClaudeConversationCandidates(root)
    expect(candidate?.conversationId).toBe("sess_1")
    expect(candidate?.cwd).toBe("/Volumes/SSDExternalMacStudio/Code/_agentproto-worktrees/ts/term-conv-harmonize")
    expect(candidate?.preview).toBe("launch")
  })

  it("falls back to the modal cwd when the first content line has none", async () => {
    const root = setupProjectsRoot()
    const dir = join(root, "modal")
    mkdirSync(dir, { recursive: true })
    writeJsonl(join(dir, "sess_2.jsonl"), [
      { type: "system", timestamp: "2026-07-19T10:00:00.000Z", message: { role: "system", content: "meta" } },
      { type: "user", timestamp: "2026-07-19T10:01:00.000Z", cwd: "/tmp/a", message: { role: "user", content: "first" } },
      { type: "assistant", timestamp: "2026-07-19T10:02:00.000Z", cwd: "/tmp/a", message: { role: "assistant", content: "second" } },
      { type: "assistant", timestamp: "2026-07-19T10:03:00.000Z", cwd: "/tmp/b", message: { role: "assistant", content: "second" } },
    ])

    const [candidate] = await listClaudeConversationCandidates(root)
    expect(candidate?.cwd).toBe("/tmp/a")
  })

  it("keeps cwd undefined when no content line carries one", async () => {
    const root = setupProjectsRoot()
    const dir = join(root, "missing")
    mkdirSync(dir, { recursive: true })
    writeJsonl(join(dir, "sess_3.jsonl"), [
      { type: "user", timestamp: "2026-07-19T11:00:00.000Z", message: { role: "user", content: "hello" } },
    ])

    const [candidate] = await listClaudeConversationCandidates(root)
    expect(candidate?.cwd).toBeUndefined()
    expect(candidate?.contentLineCount).toBe(1)
  })
})

