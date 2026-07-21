import { describe, expect, it } from "vitest"

import { listImportCandidates } from "../conversation-import.js"
import type { ConversationStore } from "../conversation-store.js"

/** A store whose discover returns a fixed set for any cwd, with a native argv. */
function reattachable(slug: string, byCwd: Record<string, { conversationId: string; startedAt?: string; lastActivityAt?: string; preview?: string }[]>): ConversationStore {
  return {
    storeAs: "hermesResumeId",
    attachArgv: (id: string) => [slug, "--resume", id, "--tui"],
    discover: async ({ cwd }) => byCwd[cwd] ?? [],
    read: async () => ({ provider: slug, conversationId: "x", messages: [] }) as never,
  }
}

/** A read-only store (no attachArgv) — must be excluded from imports. */
function readOnly(slug: string): ConversationStore {
  return {
    storeAs: "codexResumeId",
    discover: async () => [{ conversationId: `${slug}-1`, preview: "nope" }],
    read: async () => ({ provider: slug, conversationId: "x", messages: [] }) as never,
  }
}

const scanClaude = async () => [
  { conversationId: "cc-1", filePath: "/p/a.jsonl", cwd: "/repo/a", firstContentAt: "2026-07-20T10:00:00Z", preview: "claude one", contentLineCount: 5, cwdVariantCount: 1 },
  { conversationId: "cc-2", filePath: "/p/b.jsonl", firstContentAt: "2026-07-19T10:00:00Z", preview: "claude two (no cwd)", contentLineCount: 3, cwdVariantCount: 0 },
]

describe("listImportCandidates", () => {
  it("tags claude candidates from the global scanner with argv + cwd", async () => {
    const stores = { "claude-code": { storeAs: "claudeResumeId", attachArgv: (id: string) => ["claude", "--resume", id], discover: async () => [], read: async () => ({}) as never } as ConversationStore }
    const list = await listImportCandidates({}, { stores, scanClaude })
    expect(list.map(c => c.conversationId)).toEqual(["cc-1", "cc-2"])
    expect(list[0]).toMatchObject({ adapterSlug: "claude-code", harnessLabel: "Claude Code", cwd: "/repo/a", attachArgv: ["claude", "--resume", "cc-1"] })
    expect(list[1]?.cwd).toBeUndefined() // no cwd on the jsonl → caller prompts
  })

  it("discovers a cwd-scoped reattachable store (hermes) across the given cwds", async () => {
    const stores = {
      hermes: reattachable("hermes", { "/repo/a": [{ conversationId: "h-1", lastActivityAt: "2026-07-21T12:00:00Z", preview: "hermes chat" }] }),
    }
    const list = await listImportCandidates({ cwds: ["/repo/a", "/repo/b"] }, { stores, scanClaude: async () => [] })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ adapterSlug: "hermes", harnessLabel: "Hermes", cwd: "/repo/a", attachArgv: ["hermes", "--resume", "h-1", "--tui"] })
  })

  it("excludes a read-only store (no attachArgv) entirely", async () => {
    const stores = { codex: readOnly("codex") }
    const list = await listImportCandidates({ cwds: ["/repo/a"] }, { stores, scanClaude: async () => [] })
    expect(list).toEqual([])
  })

  it("dedupes the same chat surfaced under multiple cwds", async () => {
    const dup = [{ conversationId: "h-dup", lastActivityAt: "2026-07-21T09:00:00Z" }]
    const stores = { hermes: reattachable("hermes", { "/repo/a": dup, "/repo/b": dup }) }
    const list = await listImportCandidates({ cwds: ["/repo/a", "/repo/b"] }, { stores, scanClaude: async () => [] })
    expect(list).toHaveLength(1)
  })

  it("sorts newest-first across harnesses and survives a store that throws for one cwd", async () => {
    const stores = {
      "claude-code": { storeAs: "claudeResumeId", attachArgv: (id: string) => ["claude", "--resume", id], discover: async () => [], read: async () => ({}) as never } as ConversationStore,
      hermes: {
        storeAs: "hermesResumeId",
        attachArgv: (id: string) => ["hermes", "--resume", id, "--tui"],
        discover: async ({ cwd }: { cwd: string }) => {
          if (cwd === "/bad") throw new Error("unreadable db")
          return [{ conversationId: "h-new", lastActivityAt: "2026-07-22T00:00:00Z", preview: "newest" }]
        },
        read: async () => ({}) as never,
      } as ConversationStore,
    }
    const list = await listImportCandidates({ cwds: ["/bad", "/repo/a"] }, { stores, scanClaude })
    // hermes h-new (2026-07-22) is newest, then claude cc-1 (07-20), cc-2 (07-19)
    expect(list.map(c => c.conversationId)).toEqual(["h-new", "cc-1", "cc-2"])
  })
})
