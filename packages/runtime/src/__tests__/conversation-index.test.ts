/**
 * Tests for conversation-index.ts — the persisted, append-only session ↔
 * native-transcript memo (DESIGN.md `agentproto-state-multitenancy` §6).
 *
 * Everything runs against a tmpdir bucketsRoot — never the real
 * ~/.agentproto/workspaces — same isolation technique as
 * sessions-partitioning.test.ts, just without needing to fake $HOME since
 * this module takes `bucketsRoot` as an explicit argument.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendConversationRecord,
  conversationIndexPath,
  findConversationRecord,
  locateConversationByNativePath,
  locateConversationBySessionId,
  readConversationIndex,
  resolveNativeLink,
  type ConversationIndexRecord,
} from "../conversation-index.js"
import { bucketDir, listBuckets } from "../workspace-buckets.js"

const baseRecord = (overrides: Partial<ConversationIndexRecord> = {}): ConversationIndexRecord => ({
  sessionId: "sess_aaaa1111",
  workspace: "default",
  cwd: "/tmp/proj",
  adapterSlug: "claude-code",
  adapterSessionId: "11111111-0000-0000-0000-000000000001",
  agentprotoTranscript: "/tmp/.agentproto/sessions/sess_aaaa1111/events.jsonl",
  startedAt: "2026-07-18T10:00:00.000Z",
  ...overrides,
})

describe("conversation-index — round-trip + upsert", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "conversation-index-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("writes to <root>/<slug>/conversations.jsonl", async () => {
    const record = baseRecord()
    await appendConversationRecord(root, "default", record)
    const path = conversationIndexPath(root, "default")
    expect(path).toBe(join(root, "default", "conversations.jsonl"))
    const raw = readFileSync(path, "utf8")
    expect(JSON.parse(raw.trim())).toEqual(record)
  })

  it("creates the bucket dir on first write (a bucket with only terminal/command sessions won't have one)", async () => {
    await appendConversationRecord(root, "fresh-bucket", baseRecord())
    expect(listBuckets(root)).toContain("fresh-bucket")
  })

  it("read of an empty/missing bucket returns [] — not a throw", async () => {
    await expect(readConversationIndex(root, "nope")).resolves.toEqual([])
  })

  it("multiple appends for the SAME sessionId: the reader returns only the LAST one (upsert semantics)", async () => {
    const v1 = baseRecord({ title: "first title", endedAt: undefined })
    const v2 = baseRecord({ title: "second title", endedAt: "2026-07-18T10:05:00.000Z" })
    await appendConversationRecord(root, "default", v1)
    await appendConversationRecord(root, "default", v2)

    const rows = await readConversationIndex(root, "default")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(v2)

    // The file itself still has BOTH lines — append-only, never rewritten.
    const raw = readFileSync(conversationIndexPath(root, "default"), "utf8")
    const lines = raw.trim().split("\n")
    expect(lines).toHaveLength(2)
  })

  it("distinct sessionIds in the same bucket both survive", async () => {
    await appendConversationRecord(root, "default", baseRecord({ sessionId: "sess_a" }))
    await appendConversationRecord(root, "default", baseRecord({ sessionId: "sess_b" }))
    const rows = await readConversationIndex(root, "default")
    expect(rows.map(r => r.sessionId).sort()).toEqual(["sess_a", "sess_b"])
  })

  it("a malformed line is skipped, not fatal — the rest of the file still reads", async () => {
    const path = conversationIndexPath(root, "default")
    mkdirSync(bucketDir(root, "default"), { recursive: true })
    const good1 = baseRecord({ sessionId: "sess_good1" })
    const good2 = baseRecord({ sessionId: "sess_good2" })
    appendFileSync(path, JSON.stringify(good1) + "\n")
    appendFileSync(path, "{not valid json at all\n")
    appendFileSync(path, "\n") // blank line — also tolerated
    appendFileSync(path, JSON.stringify({ sessionId: "sess_shape_bad" }) + "\n") // missing required fields
    appendFileSync(path, JSON.stringify(good2) + "\n")

    const rows = await readConversationIndex(root, "default")
    expect(rows.map(r => r.sessionId).sort()).toEqual(["sess_good1", "sess_good2"])
  })

  it("findConversationRecord returns undefined for an unknown sessionId in a real bucket", async () => {
    await appendConversationRecord(root, "default", baseRecord())
    await expect(findConversationRecord(root, "default", "sess_unknown")).resolves.toBeUndefined()
  })
})

describe("conversation-index — forward lookup (sessionId → record, across buckets)", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "conversation-index-fwd-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("finds a session regardless of which bucket it landed in, without the caller naming the bucket", async () => {
    await appendConversationRecord(root, "alpha", baseRecord({ sessionId: "sess_in_alpha", workspace: "alpha" }))
    await appendConversationRecord(root, "beta", baseRecord({ sessionId: "sess_in_beta", workspace: "beta" }))

    const found = await locateConversationBySessionId(root, () => listBuckets(root), "sess_in_beta")
    expect(found?.workspace).toBe("beta")
    expect(found?.record.sessionId).toBe("sess_in_beta")
  })

  it("returns undefined when no bucket's index has ever recorded the session", async () => {
    await appendConversationRecord(root, "alpha", baseRecord({ sessionId: "sess_in_alpha" }))
    const found = await locateConversationBySessionId(root, () => listBuckets(root), "sess_never_seen")
    expect(found).toBeUndefined()
  })
})

describe("conversation-index — reverse lookup (native jsonl path → owning session)", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "conversation-index-rev-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("resolves the ROOT conversation path back to its session/workspace", async () => {
    const record = baseRecord({
      sessionId: "sess_root_match",
      workspace: "default",
      native: {
        kind: "claude-jsonl",
        path: "/home/u/.claude/projects/-tmp-proj/11111111-0000-0000-0000-000000000001.jsonl",
        subagents: [],
      },
    })
    await appendConversationRecord(root, "default", record)

    const found = await locateConversationByNativePath(
      root,
      () => listBuckets(root),
      "/home/u/.claude/projects/-tmp-proj/11111111-0000-0000-0000-000000000001.jsonl",
    )
    expect(found?.workspace).toBe("default")
    expect(found?.record.sessionId).toBe("sess_root_match")
    expect(found?.matchedSubagentPath).toBeUndefined()
  })

  it("resolves a SUBAGENT transcript path back to the PARENT session, flagging which subagent matched", async () => {
    const subagentPath =
      "/home/u/.claude/projects/-tmp-proj/11111111-0000-0000-0000-000000000001/subagents/agent-ae03cafe.jsonl"
    const record = baseRecord({
      sessionId: "sess_with_subagent",
      native: {
        kind: "claude-jsonl",
        path: "/home/u/.claude/projects/-tmp-proj/11111111-0000-0000-0000-000000000001.jsonl",
        subagents: [subagentPath],
      },
    })
    await appendConversationRecord(root, "default", record)

    const found = await locateConversationByNativePath(root, () => listBuckets(root), subagentPath)
    expect(found?.record.sessionId).toBe("sess_with_subagent")
    expect(found?.matchedSubagentPath).toBe(subagentPath)
  })

  it("returns undefined for a path no record's native.path/subagents matches", async () => {
    await appendConversationRecord(
      root,
      "default",
      baseRecord({
        native: { kind: "claude-jsonl", path: "/x/y/z.jsonl", subagents: [] },
      }),
    )
    const found = await locateConversationByNativePath(root, () => listBuckets(root), "/nope/nope.jsonl")
    expect(found).toBeUndefined()
  })

  it("records with no `native` (unresolvable adapter) are skipped without throwing", async () => {
    await appendConversationRecord(root, "default", baseRecord({ sessionId: "sess_no_native" }))
    const found = await locateConversationByNativePath(root, () => listBuckets(root), "/anything.jsonl")
    expect(found).toBeUndefined()
  })
})

describe("resolveNativeLink", () => {
  let fakeHome: string
  let originalHome: string | undefined

  beforeEach(() => {
    originalHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "conversation-index-resolve-"))
    process.env.HOME = fakeHome
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it("claude-code: derives the jsonl path via the CORRECTED claudeProjectSlug, and [] subagents when none exist", async () => {
    const cwd = "/Users/jeremy/.agentproto/worktrees/ts/gc-fresh-hold"
    const adapterSessionId = "22222222-0000-0000-0000-000000000002"
    const native = await resolveNativeLink({ cwd, adapterSlug: "claude-code", adapterSessionId })
    expect(native).toEqual({
      kind: "claude-jsonl",
      path: join(
        fakeHome,
        ".claude",
        "projects",
        "-Users-jeremy--agentproto-worktrees-ts-gc-fresh-hold",
        `${adapterSessionId}.jsonl`,
      ),
      subagents: [],
    })
  })

  it("claude-code: captures subagent transcripts under <sessionId>/subagents/agent-*.jsonl", async () => {
    const cwd = "/tmp/subagent-proj"
    const adapterSessionId = "33333333-0000-0000-0000-000000000003"
    const projectDir = join(fakeHome, ".claude", "projects", "-tmp-subagent-proj")
    const subagentsDir = join(projectDir, adapterSessionId, "subagents")
    mkdirSync(subagentsDir, { recursive: true })
    appendFileSync(join(subagentsDir, "agent-b2.jsonl"), "")
    appendFileSync(join(subagentsDir, "agent-a1.jsonl"), "")
    appendFileSync(join(subagentsDir, "agent-a1.meta.json"), "{}") // must NOT be picked up

    const native = await resolveNativeLink({ cwd, adapterSlug: "claude-code", adapterSessionId })
    expect(native?.kind).toBe("claude-jsonl")
    if (native?.kind !== "claude-jsonl") throw new Error("expected claude-jsonl")
    expect(native.subagents).toEqual([
      join(subagentsDir, "agent-a1.jsonl"),
      join(subagentsDir, "agent-b2.jsonl"),
    ])
  })

  it("hermes: rowId == adapterSessionId, dbPath under ~/.hermes/state.db — no filesystem probe needed", async () => {
    const native = await resolveNativeLink({
      cwd: "/tmp/proj",
      adapterSlug: "hermes",
      adapterSessionId: "hermes-row-42",
    })
    expect(native).toEqual({
      kind: "hermes-sqlite",
      dbPath: join(fakeHome, ".hermes", "state.db"),
      rowId: "hermes-row-42",
    })
  })

  it("unknown adapter: returns undefined rather than guessing a path", async () => {
    const native = await resolveNativeLink({
      cwd: "/tmp/proj",
      adapterSlug: "mastracode",
      adapterSessionId: "whatever",
    })
    expect(native).toBeUndefined()
  })
})
