/**
 * Tests for conversation-read.ts — the `conversation_read` verb that works
 * on ANY session kind (agent-cli or PTY). Fixtures are plain .jsonl files
 * under a fake $HOME (same technique as conversation-store.test.ts /
 * resume-strategies.test.ts) so the claude-code store's discover/read can
 * run for real, with a stub registry standing in for the daemon's.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { readConversation, registerConversationReadTool } from "../conversation-read.js"
import { CONVERSATION_STORES } from "../conversation-store.js"
import type { SessionDescriptor, SessionsRegistry } from "../sessions.js"

// ── fixtures ──────────────────────────────────────────────────────────

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

function setupFakeHome(): void {
  originalHome = process.env.HOME
  fakeHome = mkdtempSync(join(tmpdir(), "conversation-read-"))
  process.env.HOME = fakeHome
}

function claudeProjectDir(cwd: string): string {
  const encoded = cwd.replace(/\//g, "-")
  const dir = join(fakeHome, ".claude", "projects", encoded)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeJsonl(dir: string, uuid: string, lines: object[]): void {
  const content = lines.map(l => JSON.stringify(l)).join("\n") + "\n"
  writeFileSync(join(dir, `${uuid}.jsonl`), content)
}

/** Minimal descriptor — only the fields conversation-read.ts reads. */
function makeDescriptor(overrides: Partial<SessionDescriptor>): SessionDescriptor {
  return {
    id: "sess_test",
    kind: "terminal",
    workspaceSlug: "default",
    command: "test",
    pid: 1234,
    status: "running",
    startedAt: "2026-05-13T09:00:00.000Z",
    ...overrides,
  }
}

function stubRegistry(desc: SessionDescriptor | undefined): SessionsRegistry {
  return {
    findByIdOrName: () => desc,
  } as unknown as SessionsRegistry
}

// ── ladder step 1: adapterSessionId (agent-cli session) ────────────────

describe("readConversation — agent-cli session (adapterSessionId, ladder step 1)", () => {
  it("reads the conversation via the exact adapterSessionId, ignoring a newer sibling", async () => {
    setupFakeHome()
    const cwd = "/my/proj"
    const dir = claudeProjectDir(cwd)
    const own = "aaaaaaaa-0000-0000-0000-000000000001"
    const sibling = "bbbbbbbb-0000-0000-0000-000000000002"
    writeJsonl(dir, own, [
      {
        type: "user",
        timestamp: "2026-05-13T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hello own" }] },
      },
    ])
    // Newer sibling present — must never be picked instead of the exact id.
    writeJsonl(dir, sibling, [
      {
        type: "user",
        timestamp: "2026-05-13T12:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hello sibling" }] },
      },
    ])

    const desc = makeDescriptor({
      kind: "agent-cli",
      adapterSlug: "claude-code",
      adapterSessionId: own,
      cwd,
    })
    const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })

    expect(result.conversation).not.toBeNull()
    expect(result.conversationId).toBe(own)
    expect(result.adapter).toBe("claude-code")
    expect(result.content).toContain("hello own")
    expect(result.reason).toBeUndefined()
  })

  it("surfaces a clean reason (not a crash) when the store's read throws not-found", async () => {
    setupFakeHome()
    const cwd = "/no/transcript/here"
    claudeProjectDir(cwd)
    const desc = makeDescriptor({
      kind: "agent-cli",
      adapterSlug: "claude-code",
      adapterSessionId: "missing-uuid-0000",
      cwd,
    })
    const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })
    expect(result.conversation).toBeNull()
    expect(result.reason).toBeTruthy()
  })
})

// ── ladder step 2: --resume argv rescue (orphan PTY, no adapterSessionId) ─

describe("readConversation — PTY with --resume in argv, no adapterSessionId (ladder step 2)", () => {
  it("reads via argv --resume <uuid> + argv[0] binary inference (the session-37 shape)", async () => {
    setupFakeHome()
    const cwd = "/my/proj"
    const dir = claudeProjectDir(cwd)
    const uuid = "63e014d3-0000-0000-0000-000000000037"
    writeJsonl(dir, uuid, [
      {
        type: "assistant",
        timestamp: "2026-05-13T16:57:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "resumed via argv" }] },
      },
    ])

    // No adapterSlug, no adapterSessionId — the ONLY link to the
    // conversation is the uuid baked into argv, exactly like the orphan
    // PTY `sess_63e014d3` in the SPEC.
    const desc = makeDescriptor({
      kind: "terminal",
      pty: true,
      argv: ["claude", "--resume", uuid],
      cwd,
    })
    const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })

    expect(result.conversation).not.toBeNull()
    expect(result.conversationId).toBe(uuid)
    expect(result.adapter).toBe("claude-code")
    expect(result.content).toContain("resumed via argv")
  })

  it("also accepts the short -r flag", async () => {
    setupFakeHome()
    const cwd = "/my/proj2"
    const dir = claudeProjectDir(cwd)
    const uuid = "aaaaaaaa-1111-0000-0000-000000000001"
    writeJsonl(dir, uuid, [
      {
        type: "user",
        timestamp: "2026-05-13T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "short flag" }] },
      },
    ])
    const desc = makeDescriptor({ kind: "terminal", pty: true, argv: ["claude", "-r", uuid], cwd })
    const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })
    expect(result.conversationId).toBe(uuid)
  })
})

// ── no conversation: bare PTY (bash) ────────────────────────────────────

describe("readConversation — bare PTY with no conversation", () => {
  it("returns conversation: null with a reason for a bash PTY — not an error", async () => {
    setupFakeHome()
    const desc = makeDescriptor({
      kind: "terminal",
      pty: true,
      argv: ["bash"],
      cwd: "/home/user",
    })
    const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })
    expect(result.conversation).toBeNull()
    expect(result.reason).toBeTruthy()
    expect(result.candidates).toBeUndefined()
  })

  it("returns conversation: null when the session id itself is unknown", async () => {
    setupFakeHome()
    const result = await readConversation(stubRegistry(undefined), { idOrName: "sess_ghost" })
    expect(result.conversation).toBeNull()
    expect(result.reason).toContain("not found")
  })

  it("returns conversation: null when the store has nothing for this cwd/time window", async () => {
    setupFakeHome()
    const cwd = "/empty/project"
    claudeProjectDir(cwd)
    const desc = makeDescriptor({ kind: "agent-cli", adapterSlug: "claude-code", cwd })
    const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })
    expect(result.conversation).toBeNull()
    expect(result.reason).toBeTruthy()
    expect(result.candidates).toBeUndefined()
  })
})

// ── ambiguous discovery: never auto-pick ────────────────────────────────

describe("readConversation — ambiguous discovery", () => {
  it("returns the candidate list instead of guessing when discover finds more than one", async () => {
    setupFakeHome()
    const cwd = "/shared/proj"
    const dir = claudeProjectDir(cwd)
    const idA = "aaaaaaaa-2222-0000-0000-000000000001"
    const idB = "bbbbbbbb-2222-0000-0000-000000000002"
    writeJsonl(dir, idA, [
      {
        type: "user",
        timestamp: "2026-05-13T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "conversation A" }] },
      },
    ])
    writeJsonl(dir, idB, [
      {
        type: "user",
        timestamp: "2026-05-13T11:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "conversation B" }] },
      },
    ])

    // No adapterSessionId, no --resume argv — falls through to step 3
    // (store.discover), which finds both A and B active since startedAt.
    const desc = makeDescriptor({
      kind: "agent-cli",
      adapterSlug: "claude-code",
      cwd,
      startedAt: "2026-05-13T09:00:00.000Z",
    })
    const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })

    expect(result.conversation).toBeNull()
    expect(result.conversationId).toBeUndefined()
    expect(result.reason).toMatch(/multiple/i)
    expect(result.candidates).toBeDefined()
    expect(result.candidates?.map(c => c.conversationId).sort()).toEqual([idA, idB].sort())
  })
})

// ── ladder step 3 narrowing: `until` + `attachmentMode` (sess_fea9b4f3) ──

describe("readConversation — ladder step 3 narrows 5 candidates to 1 (the sess_fea9b4f3 shape)", () => {
  it("resolves to the single real conversation, not ambiguous, for a dead terminal session", async () => {
    setupFakeHome()
    const cwd = "/repo/agentproto"
    const dir = claudeProjectDir(cwd)
    const real = "c618de81-1016-45f7-bfe4-e24e2121f025"
    writeJsonl(dir, real, [
      {
        type: "user",
        timestamp: "2026-07-15T02:51:07.987Z",
        entrypoint: "cli",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ])

    const siblings = [
      "11111111-0000-0000-0000-000000000001",
      "22222222-0000-0000-0000-000000000002",
      "33333333-0000-0000-0000-000000000003",
      "44444444-0000-0000-0000-000000000004",
    ]
    for (const sib of siblings) {
      writeJsonl(dir, sib, [
        {
          type: "user",
          timestamp: "2026-07-16T09:00:00.000Z",
          entrypoint: "sdk-ts",
          message: { role: "user", content: [{ type: "text", text: "unrelated, a day later" }] },
        },
      ])
    }

    // No adapterSessionId, no --resume argv — a bare `claude` PTY, exactly
    // like sess_fea9b4f3. `endedAt` set (dead session) is what lets `until`
    // narrow away the 4 siblings.
    const desc = makeDescriptor({
      kind: "terminal",
      pty: true,
      argv: ["claude"],
      cwd,
      startedAt: "2026-07-15T02:51:04.000Z",
      endedAt: "2026-07-15T03:17:21.000Z",
    })
    const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })

    expect(result.conversation).not.toBeNull()
    expect(result.conversationId).toBe(real)
    expect(result.adapter).toBe("claude-code")
    expect(result.candidates).toBeUndefined()
    expect(result.reason).toBeUndefined()
  })
})

// ── MCP tool registration ────────────────────────────────────────────────

async function makeClient(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

describe("conversation_read tool — registration", () => {
  it("is listed in tools/list with a description mentioning conversation", async () => {
    const server = new McpServer({ name: "test-conversation-read", version: "0.0.1" })
    registerConversationReadTool(server, { registry: stubRegistry(undefined) })
    const client = await makeClient(server)

    const result = await client.listTools()
    const tool = result.tools.find(t => t.name === "conversation_read")
    expect(tool).toBeDefined()
    expect(tool?.description?.toLowerCase()).toContain("conversation")

    await client.close()
  })

  it("returns a null-conversation JSON body (not an MCP error) for a bash PTY", async () => {
    setupFakeHome()
    const desc = makeDescriptor({ kind: "terminal", pty: true, argv: ["bash"], cwd: "/home/user" })
    const server = new McpServer({ name: "test-conversation-read-2", version: "0.0.1" })
    registerConversationReadTool(server, { registry: stubRegistry(desc) })
    const client = await makeClient(server)

    const result = await client.callTool({
      name: "conversation_read",
      arguments: { idOrName: "sess_test" },
    })

    expect(result.isError).toBeFalsy()
    const content0 = (result.content as Array<{ type: string; text: string }>)[0]
    const parsed = JSON.parse(content0?.text ?? "{}")
    expect(parsed.conversation).toBeNull()
    expect(parsed.reason).toBeTruthy()

    await client.close()
  })

  it("returns isError=true for an unknown session id", async () => {
    const server = new McpServer({ name: "test-conversation-read-3", version: "0.0.1" })
    registerConversationReadTool(server, { registry: stubRegistry(undefined) })
    const client = await makeClient(server)

    const result = await client.callTool({
      name: "conversation_read",
      arguments: { idOrName: "sess_ghost" },
    })

    expect(result.isError).toBe(true)

    await client.close()
  })
})

// ── daemon-events fallback (readConversation) ────────────────────────────
//
// When the provider's native transcript is missing (e.g. a process killed
// mid-turn before claude-code finalized its own jsonl), readConversation
// falls back to the daemon's own capture in events.jsonl — keyed by the
// agentproto session id (desc.id), NOT the native conversation id.

function writeEventsJsonl(sessionId: string, lines: object[]): void {
  const dir = join(fakeHome, ".agentproto", "sessions", sessionId)
  mkdirSync(dir, { recursive: true })
  const content = lines.map(l => JSON.stringify(l)).join("\n") + "\n"
  writeFileSync(join(dir, "events.jsonl"), content)
}

describe("readConversation — daemon-events fallback when the native jsonl is missing", () => {
  it("recovers from a missing native jsonl via events.jsonl, marking source daemon-events", async () => {
    setupFakeHome()
    const cwd = "/gone/transcript"
    claudeProjectDir(cwd) // native dir exists but no jsonl written in it
    const desc = makeDescriptor({
      kind: "agent-cli",
      adapterSlug: "claude-code",
      adapterSessionId: "missing-uuid-0000",
      cwd,
    })
    writeEventsJsonl(desc.id, [
      { seq: 1, ts: "2026-05-13T10:00:00.000Z", kind: "user-prompt", text: "hello daemon" },
      { seq: 2, ts: "2026-05-13T10:00:01.000Z", kind: "text-delta", text: "hi from events\n" },
      { seq: 3, ts: "2026-05-13T10:00:02.000Z", kind: "turn-end" },
    ])

    const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })

    expect(result.conversation).not.toBeNull()
    expect(result.conversation?.meta.source).toBe("daemon-events")
    expect(result.conversationId).toBe("missing-uuid-0000")
    expect(result.reason).toBeUndefined()
    // The daemon-events transcript should render as content (here a user
    // prompt + an assistant text-delta).
    expect(result.content).toContain("hello daemon")
    expect(result.content).toContain("hi from events")
  })

  it("combines both failure messages when neither the native jsonl nor events.jsonl exists", async () => {
    setupFakeHome()
    const cwd = "/no/transcript/at/all"
    claudeProjectDir(cwd) // no native jsonl, and NO events.jsonl
    const desc = makeDescriptor({
      kind: "agent-cli",
      adapterSlug: "claude-code",
      adapterSessionId: "missing-uuid-9999",
      cwd,
    })

    const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })

    expect(result.conversation).toBeNull()
    expect(result.reason).toBeTruthy()
    expect(result.reason).toContain("daemon-events fallback also failed")
  })

  it("reads the native jsonl with no events.jsonl present — the happy path is unchanged", async () => {
    setupFakeHome()
    const cwd = "/present/transcript"
    const dir = claudeProjectDir(cwd)
    const own = "cccccccc-0000-0000-0000-000000000001"
    writeJsonl(dir, own, [
      {
        type: "user",
        timestamp: "2026-05-13T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "native only" }] },
      },
    ])
    // Deliberately NO events.jsonl — must not be required for the native path.
    const desc = makeDescriptor({
      kind: "agent-cli",
      adapterSlug: "claude-code",
      adapterSessionId: own,
      cwd,
    })

    const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })

    expect(result.conversation).not.toBeNull()
    expect(result.reason).toBeUndefined()
    expect(result.conversation?.meta.source).not.toBe("daemon-events")
    expect(result.content).toContain("native only")
  })
})

// ── daemon fallback when conversation-id resolution finds nothing ──────
//
// `resolveConversationId` returns `{ kind: "none" }` for a bare PTY with no
// known agent binary and no `--resume` argv — previously a dead end,
// now rescued by the same daemon-events fallback used for a native-read
// failure. Keyed by `desc.id` (the agentproto session id), since there is
// no native conversation id to key by.

describe("readConversation — daemon fallback when id resolution fails entirely (resolved.kind === 'none')", () => {
  it("falls back to events.jsonl for a PTY with no known agent binary and no --resume argv", async () => {
    setupFakeHome()
    const desc = makeDescriptor({
      kind: "terminal",
      pty: true,
      argv: ["some-unknown-binary"],
      cwd: "/home/user",
    })
    writeEventsJsonl(desc.id, [
      { seq: 1, ts: "2026-05-13T10:00:00.000Z", kind: "user-prompt", text: "rescued unknown binary" },
      { seq: 2, ts: "2026-05-13T10:00:01.000Z", kind: "turn-end" },
    ])

    const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })

    expect(result.conversation).not.toBeNull()
    expect(result.conversation?.meta.source).toBe("daemon-events")
    expect(result.conversationId).toBe(desc.id)
    expect(result.adapter).toBe("daemon")
    expect(result.reason).toBeUndefined()
    expect(result.content).toContain("rescued unknown binary")
  })

  it("combines both messages when there's no known store AND no events.jsonl", async () => {
    setupFakeHome()
    const desc = makeDescriptor({
      kind: "terminal",
      pty: true,
      argv: ["some-unknown-binary"],
      cwd: "/home/user",
    })
    // Deliberately no events.jsonl written for desc.id.

    const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })

    expect(result.conversation).toBeNull()
    expect(result.reason).toBeTruthy()
    expect(result.reason).toContain("daemon-events fallback also failed")
  })
})

// ── daemon fallback when the resolved store is not registered ──────────
//
// `resolved.storeKey` is only ever produced from a key `CONVERSATION_STORES`
// already has an entry for (see `knownStoreKey`), so this is a defensive
// path guarding against the entry disappearing between resolution and the
// read that follows it. Simulated here by having the store's own
// `discover` — the last thing the ladder calls before returning
// `{ kind: "found" }` — remove its own `CONVERSATION_STORES` entry as a
// side effect, so it's gone by the time `readConversation` looks it up.

describe("readConversation — daemon fallback when the conversation store is not registered", () => {
  it("falls back to events.jsonl when CONVERSATION_STORES has no entry for the resolved store key", async () => {
    setupFakeHome()
    const cwd = "/vanishing/store"
    const dir = claudeProjectDir(cwd)
    const uuid = "dddddddd-0000-0000-0000-000000000001"
    writeJsonl(dir, uuid, [
      {
        type: "user",
        timestamp: "2026-05-13T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "will vanish" }] },
      },
    ])
    const desc = makeDescriptor({
      kind: "agent-cli",
      adapterSlug: "claude-code",
      cwd,
      startedAt: "2026-05-13T09:00:00.000Z",
    })
    writeEventsJsonl(desc.id, [
      { seq: 1, ts: "2026-05-13T10:00:00.000Z", kind: "user-prompt", text: "daemon rescue" },
      { seq: 2, ts: "2026-05-13T10:00:01.000Z", kind: "turn-end" },
    ])

    const store = CONVERSATION_STORES["claude-code"]!
    const originalDiscover = store.discover.bind(store)
    const spy = vi.spyOn(store, "discover").mockImplementation(async input => {
      const result = await originalDiscover(input)
      // Simulate the entry vanishing after the ladder already resolved
      // this session to the "claude-code" store key but before
      // readConversation's own lookup runs.
      delete CONVERSATION_STORES["claude-code"]
      return result
    })

    try {
      const result = await readConversation(stubRegistry(desc), { idOrName: "sess_test" })

      expect(result.conversation).not.toBeNull()
      expect(result.conversation?.meta.source).toBe("daemon-events")
      expect(result.conversationId).toBe(uuid)
      expect(result.adapter).toBe("claude-code")
      expect(result.reason).toBeUndefined()
      expect(result.content).toContain("daemon rescue")
    } finally {
      spy.mockRestore()
      CONVERSATION_STORES["claude-code"] = store
    }
  })
})

// ── additive transcript windowing: lastN + message-index cursor ────────
//
// PR-5 pagination: `lastN` and `cursor` narrow the rendered transcript.
// The default (neither given) MUST still return the FULL transcript —
// covered by every test above; the first test here pins it explicitly.

describe("readConversation — additive lastN + cursor windowing", () => {
  function makeMultiMessageDesc(uuid: string, cwd: string): SessionDescriptor {
    return makeDescriptor({
      kind: "agent-cli",
      adapterSlug: "claude-code",
      adapterSessionId: uuid,
      cwd,
    })
  }

  function writeMultiMessageTranscript(dir: string, uuid: string): void {
    writeJsonl(dir, uuid, [1, 2, 3, 4, 5, 6].map(n => ({
      type: "user",
      timestamp: `2026-05-13T10:00:0${n}.000Z`,
      message: { role: "user", content: [{ type: "text", text: `msg-${n}` }] },
    })))
  }

  it("returns the FULL transcript when neither lastN nor cursor is given (default unchanged)", async () => {
    setupFakeHome()
    const cwd = "/window/full"
    const dir = claudeProjectDir(cwd)
    const uuid = "eeeeeeee-0000-0000-0000-000000000001"
    writeMultiMessageTranscript(dir, uuid)

    const result = await readConversation(stubRegistry(makeMultiMessageDesc(uuid, cwd)), {
      idOrName: "sess_test",
    })
    expect(result.conversation).not.toBeNull()
    expect(result.window).toBeUndefined()
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(result.content).toContain(`msg-${n}`)
    }
  })

  it("lastN keeps only the last N messages and reports the window", async () => {
    setupFakeHome()
    const cwd = "/window/lastn"
    const dir = claudeProjectDir(cwd)
    const uuid = "eeeeeeee-0000-0000-0000-000000000002"
    writeMultiMessageTranscript(dir, uuid)

    const result = await readConversation(stubRegistry(makeMultiMessageDesc(uuid, cwd)), {
      idOrName: "sess_test",
      lastN: 2,
    })
    expect(result.conversation?.messages.map(m => m.text)).toEqual(["msg-5", "msg-6"])
    expect(result.content).toContain("msg-5")
    expect(result.content).toContain("msg-6")
    expect(result.content).not.toContain("msg-4")
    expect(result.window).toEqual({
      start: 4,
      count: 2,
      total: 6,
      truncated: true,
    })
  })

  it("cursor starts the window at the given message index and chains via nextCursor", async () => {
    setupFakeHome()
    const cwd = "/window/cursor"
    const dir = claudeProjectDir(cwd)
    const uuid = "eeeeeeee-0000-0000-0000-000000000003"
    writeMultiMessageTranscript(dir, uuid)
    const desc = makeMultiMessageDesc(uuid, cwd)

    const page1 = await readConversation(stubRegistry(desc), {
      idOrName: "sess_test",
      cursor: 2,
    })
    expect(page1.conversation?.messages.map(m => m.text)).toEqual(["msg-3", "msg-4", "msg-5", "msg-6"])
    expect(page1.window).toEqual({
      start: 2,
      count: 4,
      total: 6,
      truncated: true,
    })

    const page2 = await readConversation(stubRegistry(desc), {
      idOrName: "sess_test",
      cursor: page1.window?.start ?? 0,
      lastN: 2,
    })
    expect(page2.conversation?.messages.map(m => m.text)).toEqual(["msg-5", "msg-6"])
    expect(page2.window?.start).toBe(4)
  })

  it("cursor past EOF yields an empty window, not an error", async () => {
    setupFakeHome()
    const cwd = "/window/past-eof"
    const dir = claudeProjectDir(cwd)
    const uuid = "eeeeeeee-0000-0000-0000-000000000004"
    writeMultiMessageTranscript(dir, uuid)

    const result = await readConversation(stubRegistry(makeMultiMessageDesc(uuid, cwd)), {
      idOrName: "sess_test",
      cursor: 99,
    })
    expect(result.conversation?.messages).toEqual([])
    expect(result.window).toEqual({ start: 6, count: 0, total: 6, truncated: true })
  })
})
