/**
 * AIP-72 section 9 native-dir projection and native-dir-diff capture for
 * claude-code's auto-memory dir (`native-memory.ts`). Temp dirs only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateMemory, type MemoryDocument } from "@agentproto/memory"
import {
  NATIVE_MEMORY_BLOCK_BEGIN,
  NATIVE_MEMORY_BLOCK_END,
  diffNativeMemory,
  nativeMemoryProposals,
  nativeMemoryUnavailable,
  nativeToMemoryV1,
  projectNativeMemory,
  readNativeMemorySnapshot,
  writeNativeMemorySnapshot,
} from "../native-memory.js"

let dir: string
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "native-memory-"))
  dir = join(root, "memory")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function item(slug: string, over: Partial<MemoryDocument> = {}): MemoryDocument {
  return {
    schema: "memory/v1",
    id: `mem-${slug}`,
    slug,
    kind: "feedback",
    type: "feedback",
    title: `Title ${slug}`,
    description: `The fact about ${slug}`,
    updated_at: "2026-10-28T10:00:00.000Z",
    body: `Body of ${slug}.\n`,
    ...over,
  }
}

const read = (file: string) => readFileSync(join(dir, file), "utf8")

// Shaped like the E62 memo's run-7 file, written by Claude Code itself.
const RUN7 = `---
name: release-notes-french
description: Release notes should be written in French
metadata:
  node_type: memory
  type: feedback
  originSessionId: 57ba2314-30ee-42b0-b9a1-65d619c856fa
  modified: 2026-10-28T03:48:20.484Z
---
Write all release notes in French.
**Why:** the readers are French. See [[team-language]].
**How to apply:** every CHANGELOG entry.
`

describe("projectNativeMemory", () => {
  it("puts the agentproto block first in MEMORY.md and marks every topic file", () => {
    projectNativeMemory(dir, [item("cite-sources"), item("use-pnpm", { type: "project", kind: "project" })])
    const index = read("MEMORY.md")
    expect(index.startsWith(NATIVE_MEMORY_BLOCK_BEGIN)).toBe(true)
    expect(index).toContain(NATIVE_MEMORY_BLOCK_END)
    expect(index).toContain("- [Title cite-sources](agentproto_cite-sources.md): The fact about cite-sources")
    expect(index).toContain("- [Title use-pnpm](agentproto_use-pnpm.md): The fact about use-pnpm")
    const topic = read("agentproto_use-pnpm.md")
    expect(topic).toMatch(/^---\nname: "use-pnpm"\ndescription: "The fact about use-pnpm"\nmetadata:\n {2}type: "project"\n/)
    expect(topic).toContain('agentprotoSlug: "use-pnpm"')
    expect(topic).toContain('agentprotoId: "mem-use-pnpm"')
    expect(topic).toMatch(/agentprotoSha: "[0-9a-f]{64}"/)
    expect(topic).toContain("Body of use-pnpm.")
  })

  it("is idempotent and preserves native lines and native files", () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "MEMORY.md"), "- [Mine](feedback_mine.md) - my own line\n")
    writeFileSync(join(dir, "feedback_mine.md"), RUN7)
    const first = projectNativeMemory(dir, [item("cite-sources")])
    const afterFirst = read("MEMORY.md")
    expect(afterFirst.endsWith("- [Mine](feedback_mine.md) - my own line\n")).toBe(true)
    const second = projectNativeMemory(dir, [item("cite-sources")])
    expect(read("MEMORY.md")).toBe(afterFirst)
    expect(second).toEqual(first)
    expect(read("feedback_mine.md")).toBe(RUN7)
    // One block, never two.
    expect(afterFirst.split(NATIVE_MEMORY_BLOCK_BEGIN)).toHaveLength(2)
  })

  it("drops a projected file whose item left the digest, keeps a native file under the prefix", () => {
    projectNativeMemory(dir, [item("a-one"), item("b-two")])
    writeFileSync(join(dir, "agentproto_notes.md"), "---\nname: notes\n---\nagent wrote this\n")
    projectNativeMemory(dir, [item("b-two")])
    expect(existsSync(join(dir, "agentproto_a-one.md"))).toBe(false)
    expect(existsSync(join(dir, "agentproto_b-two.md"))).toBe(true)
    expect(read("agentproto_notes.md")).toContain("agent wrote this")
    expect(read("MEMORY.md")).not.toContain("a-one")
  })

  it("bounds the block and announces the items left out", () => {
    const many = Array.from({ length: 120 }, (_, i) => item(`item-${String(i).padStart(3, "0")}`))
    const snap = projectNativeMemory(dir, many, { maxLines: 20 })
    const index = read("MEMORY.md")
    const block = index.slice(0, index.indexOf(NATIVE_MEMORY_BLOCK_END) + NATIVE_MEMORY_BLOCK_END.length)
    expect(block.split("\n").length).toBeLessThanOrEqual(20)
    expect(snap.omitted).toBe(120 - snap.included)
    expect(snap.included).toBeGreaterThan(0)
    expect(block).toContain(`${snap.omitted} in-force memory items left out`)
    // Whole items only: every kept index line has its topic file, no more.
    const topics = readdirSync(dir).filter(f => f.startsWith("agentproto_"))
    expect(topics).toHaveLength(snap.included)
  })

  it("keeps the default block well under the CLI's 200 lines / 25KB cut", () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      item(`item-${i}`, { description: "x".repeat(400) }),
    )
    projectNativeMemory(dir, many)
    const index = read("MEMORY.md")
    expect(index.split("\n").length).toBeLessThan(100)
    expect(Buffer.byteLength(index)).toBeLessThan(12_000)
  })
})

describe("diffNativeMemory", () => {
  it("ignores the projection and reports added and changed native files", () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "feedback_old.md"), "---\nname: old\ndescription: d\nmetadata:\n  type: user\n---\nold\n")
    const snap = projectNativeMemory(dir, [item("cite-sources")])
    expect(diffNativeMemory(dir, snap)).toMatchObject({ added: [], changed: [], projectedChanged: [], projectedRemoved: [] })
    // The agent appends to the index and writes a topic file; it also edits
    // the old one. Rewriting our own block is not a native change.
    writeFileSync(join(dir, "MEMORY.md"), `${read("MEMORY.md")}- [Release notes](feedback_release.md) - French\n`)
    writeFileSync(join(dir, "feedback_release.md"), RUN7)
    writeFileSync(join(dir, "feedback_old.md"), "---\nname: old\ndescription: d2\nmetadata:\n  type: user\n---\nnew\n")
    // A respawn re-projects (an upstream item changed) and keeps the native
    // baseline of the prior snapshot, so nothing written before is lost.
    const next = projectNativeMemory(dir, [item("cite-sources", { description: "changed upstream" })], { prior: snap })
    const diff = diffNativeMemory(dir, next)
    expect(diff.projectedChanged).toEqual([])
    expect(diff.added.map(f => f.file)).toEqual(["feedback_release.md"])
    expect(diff.changed.map(f => f.file)).toEqual(["feedback_old.md"])
    expect(diff.titles["feedback_release.md"]).toBe("Release notes")
  })

  it("maps an edit of a projected file to a proposal on the same item, a deletion to archived", async () => {
    const snap = projectNativeMemory(dir, [item("cite-sources"), item("use-pnpm")])
    writeFileSync(join(dir, "agentproto_cite-sources.md"), read("agentproto_cite-sources.md").replace("Body of cite-sources.", "Cite with links."))
    unlinkSync(join(dir, "agentproto_use-pnpm.md"))
    const diff = diffNativeMemory(dir, snap)
    expect(diff.added).toEqual([])
    expect(diff.projectedChanged.map(f => f.id)).toEqual(["mem-cite-sources"])
    expect(diff.projectedRemoved.map(f => f.id)).toEqual(["mem-use-pnpm"])
    const proposals = await nativeMemoryProposals(diff, {
      sessionId: "sess_1",
      readItem: async id => (id === "mem-use-pnpm" ? item("use-pnpm") : undefined),
    })
    const edit = proposals.find(p => p.item.id === "mem-cite-sources")!
    expect(edit.item.slug).toBe("cite-sources")
    expect(edit.item.body).toContain("Cite with links.")
    expect(edit.item.status).toBe("active")
    const removal = proposals.find(p => p.item.id === "mem-use-pnpm")!
    expect(removal.item.status).toBe("archived")
    for (const p of proposals) {
      expect(validateMemory(p.item).ok, JSON.stringify(validateMemory(p.item).errors)).toBe(true)
      expect(p.item.provenance?.source).toBe("native-memory")
      expect(p.item.capture?.mode).toBe("live")
    }
  })
})

describe("nativeToMemoryV1", () => {
  it("maps the run-7 file to a valid memory/v1 item", () => {
    const doc = nativeToMemoryV1(
      { file: "feedback_release_notes_language.md", content: RUN7 },
      { sessionId: "sess_abc", tags: ["project:acme"], title: "Release notes in French", now: "2026-10-28T04:00:00.000Z" },
    )!
    expect(doc).not.toBeNull()
    const result = validateMemory(doc)
    expect(result.ok, JSON.stringify(result.errors)).toBe(true)
    expect(doc.kind).toBe(doc.type)
    expect(doc.type).toBe("feedback")
    expect(doc.slug).toBe("release-notes-french")
    expect(doc.title).toBe("Release notes in French")
    expect(doc.description).toBe("Release notes should be written in French")
    expect(doc.updated_at).toBe("2026-10-28T03:48:20.484Z")
    expect(doc.provenance).toMatchObject({
      source: "native-memory",
      ref: "claude-code:57ba2314-30ee-42b0-b9a1-65d619c856fa",
      sessionId: "sess_abc",
      at: "2026-10-28T03:48:20.484Z",
    })
    expect(doc.capture).toMatchObject({ mode: "live", producer: "adapter:claude-code" })
    expect(doc.tags).toEqual(["project:acme"])
    expect(doc).not.toHaveProperty("node_type")
    expect(doc).not.toHaveProperty("metadata")
    expect(doc).not.toHaveProperty("polarity")
    expect(doc.body).toContain("[[team-language]]")
  })

  it("kebab-cases a native name and falls back to the file stem", () => {
    const doc = nativeToMemoryV1(
      { file: "user_Prefers_Tabs.md", content: "---\ndescription: tabs\nmetadata:\n  type: user\n---\nTabs.\n" },
      { now: "2026-10-28T04:00:00.000Z" },
    )!
    expect(doc.slug).toBe("user-prefers-tabs")
    expect(validateMemory(doc).ok).toBe(true)
  })

  it("returns null for a file without a known type", () => {
    expect(nativeToMemoryV1({ file: "x.md", content: "no frontmatter" }, {})).toBeNull()
    expect(nativeToMemoryV1({ file: "x.md", content: "---\nname: x\nmetadata:\n  type: weird\n---\n" }, {})).toBeNull()
  })
})

describe("nativeMemoryUnavailable", () => {
  it("is available by default", () => {
    expect(nativeMemoryUnavailable({ cwd: root, env: {}, configDir: join(root, "cfg"), home: root })).toBeUndefined()
  })
  it("is off with CLAUDE_CODE_DISABLE_AUTO_MEMORY=1", () => {
    expect(nativeMemoryUnavailable({ cwd: root, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }, home: root })).toMatch(
      /CLAUDE_CODE_DISABLE_AUTO_MEMORY/,
    )
  })
  it("is off when the repo disables auto memory or sets its own dir", () => {
    mkdirSync(join(root, ".git"))
    mkdirSync(join(root, ".claude"))
    mkdirSync(join(root, "sub"))
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ autoMemoryEnabled: false }))
    expect(nativeMemoryUnavailable({ cwd: join(root, "sub"), env: {}, home: tmpdir() })).toMatch(/autoMemoryEnabled/)
    writeFileSync(join(root, ".claude", "settings.json"), "{}")
    writeFileSync(join(root, ".claude", "settings.local.json"), JSON.stringify({ autoMemoryDirectory: "~/mem" }))
    expect(nativeMemoryUnavailable({ cwd: root, env: {}, home: tmpdir() })).toMatch(/autoMemoryDirectory/)
  })
  it("never projects into the real ~/.claude", () => {
    expect(nativeMemoryUnavailable({ cwd: root, env: {}, configDir: join(root, ".claude"), home: root })).toMatch(/~\/\.claude/)
  })
})

describe("snapshot persistence", () => {
  it("round-trips and tolerates a missing or broken file", () => {
    expect(readNativeMemorySnapshot(root)).toBeUndefined()
    writeFileSync(join(root, ".agentproto-memory.json"), "{not json")
    expect(readNativeMemorySnapshot(root)).toBeUndefined()
    const snap = projectNativeMemory(dir, [item("cite-sources")])
    writeNativeMemorySnapshot(root, snap)
    expect(readNativeMemorySnapshot(root)).toEqual(snap)
  })
})
