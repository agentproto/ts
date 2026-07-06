/**
 * Unit tests for the `session_restart` MCP tool (session-tools.ts).
 *
 * Mirrors what `agentproto sessions restart <id>` does on the CLI, but
 * in-process: look up a (possibly historical) descriptor, pick a resume
 * strategy via the shared `decideRestartStrategy` (resume-strategies.ts),
 * and respawn. Covers the four branches of that decision tree end-to-end
 * through the MCP tool surface:
 *   - pty-native  (claude-code with a captured resume id)
 *   - agent/ACP   (adapter with no native strategy, resume via adapterSessionId)
 *   - restarting a still-alive vs. already-dead session (no liveness gate)
 *   - unsupported (generic `command` session)
 */

import { afterEach, describe, it, expect } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type {
  AgentSessionLike,
  AgentStreamEvent,
  PtyFactory,
  PtyProcess,
  SessionsRegistry,
} from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

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

/** Records every `startSession` call so tests can assert on
 *  resumeSessionId / cwd / model without spying on internals. */
function makeResolver(opts: {
  /** When set, the FIRST call with a `resumeSessionId` throws this
   *  message (simulates the adapter rejecting an unknown/never-
   *  persisted resume id) — the tool should retry without it. */
  rejectResumeOnce?: boolean
} = {}): {
  resolver: AgentAdapterResolver
  calls: Array<{ adapter: string; cwd: string; resumeSessionId?: string }>
} {
  const calls: Array<{ adapter: string; cwd: string; resumeSessionId?: string }> = []
  let rejected = false
  const resolver: AgentAdapterResolver = async slug => ({
    async startSession(sessOpts) {
      calls.push({
        adapter: slug,
        cwd: sessOpts.cwd,
        ...(sessOpts.resumeSessionId ? { resumeSessionId: sessOpts.resumeSessionId } : {}),
      })
      if (opts.rejectResumeOnce && sessOpts.resumeSessionId && !rejected) {
        rejected = true
        throw new Error("Resource not found")
      }
      return fakeAgentSession(slug)
    },
    commandPreview: `mock-${slug}`,
  })
  return { resolver, calls }
}

function makeFakePtyFactory(): PtyFactory {
  return (): PtyProcess => ({
    pid: 4242,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  })
}

async function buildHarness(
  resolverOpts: Parameters<typeof makeResolver>[0] = {},
): Promise<{
  client: Client
  registry: SessionsRegistry
  calls: Array<{ adapter: string; cwd: string; resumeSessionId?: string }>
  close: () => Promise<void>
}> {
  const sessionEvents = createSessionEventBus()
  const { resolver, calls } = makeResolver(resolverOpts)
  const registry = createSessionsRegistry({
    sessionEvents,
    persist: false,
    spawnPty: makeFakePtyFactory(),
  })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })

  registerSessionTools(server, {
    registry,
    resolveAgentAdapter: resolver,
    ptyEnabled: true,
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return { client, registry, calls, close: () => client.close() }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolJson(result: any): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}"
  return JSON.parse(text)
}

describe("session_restart", () => {
  it("pty-native: respawns via the provider's native resume command when a resume id was captured", async () => {
    const { client, registry, close } = await buildHarness()

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })
    // Simulate the output sniffer having captured `claude --resume <id>`
    // from the prior session's exit line.
    prev.resumeMetadata = { claudeResumeId: "0e483f81-1a44-4bec-9667-b37158450296" }
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    expect(desc.id).not.toBe(prev.id)
    expect(desc.resumedFrom).toBe(prev.id)
    expect(desc.resumeVia).toBe("resumed via claude --resume")
    expect(desc.kind).toBe("terminal")
    expect(desc.pty).toBe(true)
    expect(desc.argv).toEqual([
      "claude",
      "--resume",
      "0e483f81-1a44-4bec-9667-b37158450296",
    ])

    await close()
    registry.shutdown()
  })

  it("agent/ACP: resumes via the adapter's own session id for an adapter with no native strategy", async () => {
    const { client, registry, calls, close } = await buildHarness()

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("hermes"),
      adapterSlug: "hermes",
    })
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    expect(desc.id).not.toBe(prev.id)
    expect(desc.resumedFrom).toBe(prev.id)
    expect(desc.resumeVia).toBe("resumed via ACP")
    expect(desc.kind).toBe("agent-cli")
    expect(desc.adapterSlug).toBe("hermes")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.resumeSessionId).toBe(prev.adapterSessionId)

    await close()
    registry.shutdown()
  })

  it("agent/ACP: retries as a fresh spawn when the adapter rejects the resume id as not found", async () => {
    const { client, registry, calls, close } = await buildHarness({ rejectResumeOnce: true })

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("hermes"),
      adapterSlug: "hermes",
    })
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    expect(desc.resumeFallback).toBe(true)
    expect(desc.resumeVia).toBe("")

    // First call attempted the resume id and was rejected; second call
    // (the actual spawn that succeeded) carried no resumeSessionId.
    expect(calls).toHaveLength(2)
    expect(calls[0]?.resumeSessionId).toBe(prev.adapterSessionId)
    expect(calls[1]?.resumeSessionId).toBeUndefined()

    await close()
    registry.shutdown()
  })

  it("restarts a still-alive session the same way as a dead one (no liveness gate)", async () => {
    const { client, registry, close } = await buildHarness()

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("hermes"),
      adapterSlug: "hermes",
    })
    expect(registry.get(prev.id)?.status).toBe("running")

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    expect(desc.id).not.toBe(prev.id)
    expect(desc.resumedFrom).toBe(prev.id)
    // Restarting doesn't touch the prior session — it's left exactly as
    // it was (still "running"), same as the CLI's `sessions restart`.
    expect(registry.get(prev.id)?.status).toBe("running")

    await close()
    registry.shutdown()
  })

  it("restarts an already-dead (killed) session, producing a fresh id", async () => {
    const { client, registry, close } = await buildHarness()

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("hermes"),
      adapterSlug: "hermes",
    })
    registry.kill(prev.id)
    expect(registry.get(prev.id)?.status).toBe("killed")

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    expect(desc.id).not.toBe(prev.id)
    expect(desc.status).toBe("running")
    // The dead descriptor stays in history, untouched.
    expect(registry.get(prev.id)?.status).toBe("killed")

    await close()
    registry.shutdown()
  })

  it("returns an error for a generic command session — restart is unsupported", async () => {
    const { client, registry, close } = await buildHarness()

    const prev = registry.spawn({
      kind: "command",
      workspaceSlug: "default",
      cwd: process.cwd(),
      argv: ["true"],
    })

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBe(true)
    const body = toolJson(result)
    expect(String(body.error)).toMatch(/generic command session/)

    await close()
    registry.shutdown()
  })

  it("returns an error when the session id/name is unknown", async () => {
    const { client, close } = await buildHarness()

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: "sess_does_not_exist" },
    })
    expect(result.isError).toBe(true)
    const body = toolJson(result)
    expect(String(body.error)).toMatch(/no session/)

    await close()
  })
})

/**
 * Regression for the cross-session resume bug: restarting a killed
 * claude-code agent-cli session whose ring buffer was empty (so the
 * output sniffer never captured `claudeResumeId`) used to run the
 * fs-probe's mtime-latest fallback, which — when another, unrelated
 * claude session was active in the SAME cwd — resolved to THAT sibling's
 * transcript and silently resumed the wrong conversation.
 *
 * The fix binds the fs-probe to the dead session's own `adapterSessionId`
 * (== its on-disk `.jsonl` uuid for claude-code). These tests drive the
 * whole `session_restart` MCP tool against a fake HOME containing both
 * the dead session's transcript and a newer sibling's, and assert we
 * resume the former, never the latter.
 */
describe("session_restart — cross-session resume safety (regression)", () => {
  let fakeHome: string
  let originalHome: string | undefined

  afterEach(() => {
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  /** Fake `~/.claude/projects/<encoded-cwd>/` under a throwaway HOME. */
  function setupClaudeStore(cwd: string): string {
    originalHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "session-restart-regression-"))
    process.env.HOME = fakeHome
    const dir = join(fakeHome, ".claude", "projects", cwd.replace(/\//g, "-"))
    mkdirSync(dir, { recursive: true })
    return dir
  }

  function writeTranscript(dir: string, uuid: string, mtime: Date): void {
    const path = join(dir, `${uuid}.jsonl`)
    writeFileSync(path, "")
    utimesSync(path, mtime, mtime)
  }

  it("resumes the dead session's OWN transcript, not a newer sibling sharing the cwd", async () => {
    const { client, registry, close } = await buildHarness()
    const cwd = "/fake/shared-proj"
    const dir = setupClaudeStore(cwd)

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd,
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })
    const ownId = prev.adapterSessionId
    expect(ownId).toBeTruthy()
    // Dead session's own transcript is OLDER than the sibling's.
    writeTranscript(dir, ownId!, new Date("2026-05-13T10:00:00Z"))
    const siblingId = "8f536161-b989-4fa3-baf5-5c37d871d6ec"
    writeTranscript(dir, siblingId, new Date("2026-05-13T12:00:00Z"))

    registry.kill(prev.id)
    // Precondition: sniffer never captured a resume id (empty ring buffer).
    expect(prev.resumeMetadata?.claudeResumeId).toBeUndefined()

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    // The fix: resume binds to the dead session's own id, even though the
    // sibling's transcript is the most-recently modified file in the cwd.
    expect(desc.argv).toEqual(["claude", "--resume", ownId])
    expect(JSON.stringify(desc.argv)).not.toContain(siblingId)

    await close()
    registry.shutdown()
  })

  it("falls back to ACP resume against the real id — never a sibling — when the dead session's transcript is gone", async () => {
    const { client, registry, calls, close } = await buildHarness()
    const cwd = "/fake/shared-proj-2"
    const dir = setupClaudeStore(cwd)

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd,
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })
    const ownId = prev.adapterSessionId
    // Only a newer, unrelated sibling exists on disk — the dead session's
    // own transcript was never persisted / already cleaned up. Date it in
    // the future so it clears the fs-probe's `startedAt` mtime filter:
    // without the fix, mtime-latest would resume THIS sibling (pty-native).
    const siblingId = "8f536161-b989-4fa3-baf5-5c37d871d6ec"
    writeTranscript(dir, siblingId, new Date("2099-01-01T00:00:00Z"))

    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    // No pty-native resume (own transcript absent) → ACP-level resume via
    // the real adapterSessionId. Crucially, the sibling's id never leaks
    // into either the argv or the ACP resume call.
    expect(desc.kind).toBe("agent-cli")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.resumeSessionId).toBe(ownId)
    expect(calls[0]?.resumeSessionId).not.toBe(siblingId)

    await close()
    registry.shutdown()
  })
})
