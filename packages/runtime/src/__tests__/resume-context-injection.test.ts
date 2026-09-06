/**
 * Fix D: gated injection of the best-effort resume-context digest built by
 * `buildResumeContextDigest` (resume-context-digest.test.ts covers the
 * builder itself in isolation).
 *
 * Two sites stash `SessionDescriptor.pendingResumeContext`, both gated on a
 * blank-fallback flag:
 *   - the lazy resume-on-prompt path (`maybeResumeAgent` in sessions.ts),
 *     gated on `resumable === false` — mirrors resume-honesty.test.ts's
 *     harness (seed a persisted row, prompt it).
 *   - the fresh-spawn restart path (`restartAgentSession` in
 *     session-restart-core.ts), gated on `resumeFallback` — mirrors
 *     session-restart.test.ts's harness (MCP `session_restart` tool).
 *
 * `runAgentTurn` flushes the stashed digest onto the first outgoing turn
 * and clears it — this file asserts that happens exactly once, and never
 * at all for a resume that actually restored context.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as os from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { AgentAdapterResolver } from "../http-server.js"

vi.mock("node:os", async importOriginal => {
  const orig = await importOriginal<typeof import("node:os")>()
  return { ...orig, homedir: vi.fn(() => orig.homedir()) }
})

function writeEvents(tmp: string, sessionId: string, lines: object[]): void {
  const dir = join(tmp, ".agentproto", "sessions", sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "events.jsonl"),
    lines.map((l, i) => JSON.stringify({ seq: i + 1, ts: "2026-07-24T00:00:00.000Z", ...l })).join("\n") + "\n",
  )
}

// ── lazy resume-on-prompt path (maybeResumeAgent) ─────────────────────

function seedRow(persistPath: string, id: string, adapterSlug: string, resumable: boolean | undefined): void {
  mkdirSync(join(persistPath, ".."), { recursive: true })
  writeFileSync(
    persistPath,
    JSON.stringify({
      savedAt: "2026-07-24T00:00:00Z",
      sessions: [
        {
          id,
          kind: "agent-cli",
          workspaceSlug: "default",
          command: `${adapterSlug} (agent)`,
          pid: null,
          status: "running",
          startedAt: "2026-07-24T00:00:00Z",
          busy: false,
          adapterSlug,
          adapterSessionId: "conv-digest",
          cwd: "/tmp",
          ...(resumable !== undefined ? { resumable } : {}),
        },
      ],
    }),
  )
}

// `runAgentTurn` auto-wraps a string turn into `{type: "text", text}` right
// before handing it to the driver's `send` — see sessions.ts's "ACP's
// `prompt` field expects ContentBlock[]" comment. Unwrap that here so
// assertions read against the plain text the digest was prepended onto.
function sentText(message: unknown): string {
  if (typeof message === "string") return message
  if (message && typeof message === "object" && "text" in message) {
    const text = (message as { text: unknown }).text
    if (typeof text === "string") return text
  }
  throw new Error(`sentText: unexpected message shape: ${JSON.stringify(message)}`)
}

function makeResumer(sent: unknown[]): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const fresh: AgentSessionLike = {
      sessionId: "conv-digest",
      async *send(message): AsyncIterable<AgentStreamEvent> {
        sent.push(message)
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    return fresh
  })
}

describe("lazy resume-on-prompt: gated resume-context injection", () => {
  let tmp: string
  let persistPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "resume-inject-"))
    vi.mocked(os.homedir).mockReturnValue(tmp)
    persistPath = join(tmp, ".agentproto", "sessions.json")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it("resumable:false: injects the digest once, then clears it for the next turn", async () => {
    const id = "sess_inject_blank"
    seedRow(persistPath, id, "hermes", false)
    writeEvents(tmp, id, [
      { kind: "user-prompt", text: "What was I working on?" },
      { kind: "text-delta", text: "You were refactoring the auth module." },
      { kind: "turn-end", reason: "completed" },
    ])

    const sent: unknown[] = []
    const reg = createSessionsRegistry({
      persistPath,
      sessionEvents: createSessionEventBus(),
      resumeAgent: makeResumer(sent),
    })

    await reg.sendPrompt(id, "continue")
    expect(sent).toHaveLength(1)
    expect(sentText(sent[0])).toMatch(/^\[resumed session — prior conversation could not be natively restored/)
    expect(sentText(sent[0])).toContain("refactoring the auth module")
    expect(sentText(sent[0])).toContain("continue")

    // Second turn on the now-live session: no re-resume, so nothing left
    // to flush — the digest must not reappear.
    await reg.sendPrompt(id, "next message")
    expect(sent).toHaveLength(2)
    expect(sentText(sent[1])).toBe("next message")

    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("resumable:false but no prior transcript: contextNotRestored still fires, but no digest to inject", async () => {
    const id = "sess_inject_notranscript"
    seedRow(persistPath, id, "hermes", false)
    // Deliberately no events.jsonl written for this session.

    const sent: unknown[] = []
    const reg = createSessionsRegistry({
      persistPath,
      sessionEvents: createSessionEventBus(),
      resumeAgent: makeResumer(sent),
    })

    await reg.sendPrompt(id, "continue")
    expect(sent).toHaveLength(1)
    expect(sentText(sent[0])).toBe("continue")

    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })

  it("claude-code (resumable:true, real context restored): never stashes or injects a digest", async () => {
    const id = "sess_inject_real"
    seedRow(persistPath, id, "claude-code", true)
    // A prior transcript exists, but this resume is a REAL one — the
    // digest must never be built or injected for it.
    writeEvents(tmp, id, [
      { kind: "user-prompt", text: "Some prior turn." },
      { kind: "text-delta", text: "Some prior reply." },
      { kind: "turn-end", reason: "completed" },
    ])

    const sent: unknown[] = []
    const reg = createSessionsRegistry({
      persistPath,
      sessionEvents: createSessionEventBus(),
      resumeAgent: makeResumer(sent),
    })

    await reg.sendPrompt(id, "continue")
    expect(sent).toHaveLength(1)
    expect(sentText(sent[0])).toBe("continue")

    await new Promise(res => setTimeout(res, 20))
    reg.shutdown()
  })
})

// ── fresh-spawn restart path (restartAgentSession via session_restart) ──

let acpCounter = 0
function fakeAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function makeResolver(opts: { rejectResumeOnce?: boolean } = {}): AgentAdapterResolver {
  let rejected = false
  return async slug => ({
    async startSession(sessOpts) {
      if (opts.rejectResumeOnce && sessOpts.resumeSessionId && !rejected) {
        rejected = true
        throw new Error("Resource not found")
      }
      return fakeAgentSession(slug)
    },
    commandPreview: `mock-${slug}`,
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolJson(result: any): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}"
  return JSON.parse(text)
}

describe("session_restart: gated resume-context injection on a fresh-spawn fallback", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "resume-inject-restart-"))
    vi.mocked(os.homedir).mockReturnValue(tmp)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it("store-missing (rejected resume id): the fresh descriptor carries a digest built from the PRIOR session's transcript", async () => {
    const registry = createSessionsRegistry({
      sessionEvents: createSessionEventBus(),
      persist: false,
    })
    const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
    registerSessionTools(server, {
      workspace: process.cwd(),
      registry,
      resolveAgentAdapter: makeResolver({ rejectResumeOnce: true }),
      ptyEnabled: true,
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test-client", version: "0" })
    await client.connect(clientTransport)

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("hermes"),
      adapterSlug: "hermes",
    })
    writeEvents(tmp, prev.id, [
      { kind: "user-prompt", text: "Earlier question." },
      { kind: "text-delta", text: "Earlier answer." },
      { kind: "turn-end", reason: "completed" },
    ])
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    expect(desc.resumeFallback).toBe(true)
    expect(typeof desc.pendingResumeContext).toBe("string")
    expect(String(desc.pendingResumeContext)).toContain("Earlier answer.")
    expect(String(desc.pendingResumeContext)).toMatch(/best-effort summary/)

    await client.close()
    registry.shutdown()
  })

  it("clean resume (no rejection): never stashes a digest, even with a prior transcript on disk", async () => {
    const registry = createSessionsRegistry({
      sessionEvents: createSessionEventBus(),
      persist: false,
    })
    const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
    registerSessionTools(server, {
      workspace: process.cwd(),
      registry,
      resolveAgentAdapter: makeResolver(),
      ptyEnabled: true,
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test-client", version: "0" })
    await client.connect(clientTransport)

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("hermes"),
      adapterSlug: "hermes",
    })
    writeEvents(tmp, prev.id, [
      { kind: "user-prompt", text: "Earlier question." },
      { kind: "text-delta", text: "Earlier answer." },
      { kind: "turn-end", reason: "completed" },
    ])
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    expect(desc.resumeFallback).toBeUndefined()
    expect(desc.pendingResumeContext).toBeUndefined()

    await client.close()
    registry.shutdown()
  })
})
