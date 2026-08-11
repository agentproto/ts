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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, mkdirSync } from "node:fs"
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
import type { DeclaredAdapterOption } from "../spawn-defaults.js"

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
  /** Manifest-declared `capabilities.resumable`, surfaced on the resolved
   *  adapter descriptor exactly like `AgentAdapterResolver.resumable` in
   *  production — stamped onto the NEW descriptor by `restartAgentSession`. */
  resumable?: boolean
  /** Manifest-declared `capabilities.nativeTerminalResume`, surfaced on the
   *  resolved adapter descriptor exactly like
   *  `AgentAdapterResolver.nativeTerminalResume` in production. */
  nativeTerminalResume?: boolean
  /** Manifest-declared options, surfaced like `AgentAdapterResolver.declaredOptions`. */
  declaredOptions?: readonly DeclaredAdapterOption[]
  /** Manifest-declared `routeSelection`, surfaced like `AgentAdapterResolver.routeSelection`. */
  routeSelection?: "free" | "derived-from-model"
} = {}): {
  resolver: AgentAdapterResolver
  calls: Array<{
    adapter: string
    cwd: string
    resumeSessionId?: string
    posture?: string | { harnessModeId: string }
    contextProfile?: string
    options?: Record<string, boolean | number | string>
    model?: string
  }>
} {
  const calls: Array<{
    adapter: string
    cwd: string
    resumeSessionId?: string
    posture?: string | { harnessModeId: string }
    contextProfile?: string
    options?: Record<string, boolean | number | string>
    model?: string
  }> = []
  let rejected = false
  const resolver: AgentAdapterResolver = async slug => ({
    async startSession(sessOpts) {
      calls.push({
        adapter: slug,
        cwd: sessOpts.cwd,
        ...(sessOpts.resumeSessionId ? { resumeSessionId: sessOpts.resumeSessionId } : {}),
        ...(sessOpts.posture !== undefined ? { posture: sessOpts.posture } : {}),
        ...(sessOpts.contextProfile ? { contextProfile: sessOpts.contextProfile } : {}),
        ...(sessOpts.options ? { options: sessOpts.options } : {}),
        ...(sessOpts.model ? { model: sessOpts.model } : {}),
      })
      if (opts.rejectResumeOnce && sessOpts.resumeSessionId && !rejected) {
        rejected = true
        throw new Error("Resource not found")
      }
      return fakeAgentSession(slug)
    },
    commandPreview: `mock-${slug}`,
    ...(opts.resumable !== undefined ? { resumable: opts.resumable } : {}),
    ...(opts.nativeTerminalResume !== undefined
      ? { nativeTerminalResume: opts.nativeTerminalResume }
      : {}),
    ...(opts.declaredOptions ? { declaredOptions: opts.declaredOptions } : {}),
    ...(opts.routeSelection ? { routeSelection: opts.routeSelection } : {}),
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
  // Real persistence (round-trip through sessions.json) only when a caller
  // passes a path — the reload/persistence tests below need it, everything
  // else stays in-memory-only like before.
  persistPath?: string,
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
    ...(persistPath ? { persistPath } : { persist: false }),
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
    const { client, registry, close } = await buildHarness({ nativeTerminalResume: true })

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
      nativeTerminalResume: true,
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

  it("carries origin, parent, and depth forward onto the restarted descriptor (#session-visibility)", async () => {
    const { client, registry, close } = await buildHarness()

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("hermes"),
      adapterSlug: "hermes",
      origin: "cowork",
      parentSessionId: "sess_parent",
      depth: 2,
    })
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    // The regression this WP fixes: a restart used to reset lineage to a bare
    // root. It must keep the logical session's source trace.
    expect(desc.id).not.toBe(prev.id)
    expect(desc.origin).toBe("cowork")
    expect(desc.parentSessionId).toBe("sess_parent")
    expect(desc.depth).toBe(2)

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

  // ── resume-honesty fix ──────────────────────────────────────────────
  //
  // An adapter that declares `resumable: false` (hermes, mastra-agent, …)
  // cannot rehydrate a prior conversation from `adapterSessionId` at all.
  // Before this fix, `session_restart` would still pass it as
  // `resumeSessionId` and label the result "resumed via ACP" — a silent
  // lie (the session comes back blank). The restart must now degrade to a
  // CLEARLY-FLAGGED fresh spawn: no `resumeSessionId` ever attempted,
  // `resumeFallback: true`, and an honest `resumeVia` — never "resumed via
  // ACP".
  it("agent/ACP: resumable:false degrades to a flagged fresh spawn — never a phantom resumeSessionId, never 'resumed via ACP'", async () => {
    const { client, registry, calls, close } = await buildHarness({ resumable: false })

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("hermes"),
      adapterSlug: "hermes",
      resumable: false,
    })
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    expect(desc.resumeFallback).toBe(true)
    expect(desc.resumeVia).toBe("fresh — resume not supported by hermes")
    expect(desc.resumeVia).not.toBe("resumed via ACP")
    expect(desc.resumable).toBe(false)

    // Never even attempted resumeSessionId — the capability gate ruled it
    // out up front, no rejection round-trip needed.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.resumeSessionId).toBeUndefined()

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
 * `resumedFrom`/`resumeVia` used to exist only on the restart RESULT's JSON
 * (grafted on in session-tools.ts), never on the STORED descriptor — so the
 * link vanished the moment a caller re-read the session via `session_list`/
 * `session_get` instead of holding onto the original restart response. These
 * tests drive the fix: the fields must be on the registry's own descriptor,
 * not just this call's JSON, and must survive a save/reload cycle (real
 * `persistPath`, not `persist: false`) the same way every other descriptor
 * field does.
 */
describe("session_restart — resumedFrom/resumeVia persist on the stored descriptor", () => {
  let tmp: string
  let persistPath: string

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  it("agent/ACP restart: the NEW session's registry-held descriptor (not just the tool's JSON) carries resumedFrom/resumeVia", async () => {
    tmp = mkdtempSync(join(tmpdir(), "session-restart-persist-"))
    persistPath = join(tmp, "sessions.json")
    const { client, registry, close } = await buildHarness({}, persistPath)

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
    const newId = String(desc.id)

    // The descriptor the REGISTRY holds for the new id — not the tool
    // response — is what a later session_list/session_get poll reads.
    const stored = registry.get(newId)
    expect(stored?.resumedFrom).toBe(prev.id)
    expect(stored?.resumeVia).toBe("resumed via ACP")

    await close()
    registry.shutdown()
  })

  it("pty-native restart: the stored descriptor carries resumedFrom/resumeVia too", async () => {
    tmp = mkdtempSync(join(tmpdir(), "session-restart-persist-pty-"))
    persistPath = join(tmp, "sessions.json")
    const { client, registry, close } = await buildHarness({ nativeTerminalResume: true }, persistPath)

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
      nativeTerminalResume: true,
    })
    prev.resumeMetadata = { claudeResumeId: "0e483f81-1a44-4bec-9667-b37158450296" }
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)
    const newId = String(desc.id)

    const stored = registry.get(newId)
    expect(stored?.resumedFrom).toBe(prev.id)
    expect(stored?.resumeVia).toBe("resumed via claude --resume")

    await close()
    registry.shutdown()
  })

  it("survives a daemon restart: reloading sessions.json from a fresh registry still shows resumedFrom/resumeVia", async () => {
    tmp = mkdtempSync(join(tmpdir(), "session-restart-persist-reload-"))
    persistPath = join(tmp, "sessions.json")
    const { client, registry, close } = await buildHarness({}, persistPath)

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
    const newId = String(toolJson(result).id)

    await close()
    // Flush + tear down this registry, then boot a brand-new one against
    // the same file — the same thing a daemon restart does.
    registry.shutdown()

    const raw = JSON.parse(readFileSync(persistPath, "utf8"))
    const persistedRow = raw.sessions.find((s: { id: string }) => s.id === newId)
    expect(persistedRow?.resumedFrom).toBe(prev.id)
    expect(persistedRow?.resumeVia).toBe("resumed via ACP")

    const reloaded = createSessionsRegistry({ persistPath })
    const afterReload = reloaded.get(newId)
    expect(afterReload?.resumedFrom).toBe(prev.id)
    expect(afterReload?.resumeVia).toBe("resumed via ACP")
    reloaded.shutdown()
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
    const { client, registry, close } = await buildHarness({ nativeTerminalResume: true })
    const cwd = "/fake/shared-proj"
    const dir = setupClaudeStore(cwd)

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd,
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
      nativeTerminalResume: true,
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

  it("restart-with-override forces the agent path and lands each axis on the fresh descriptor (step 6)", async () => {
    // A claude-code session that WOULD normally restart pty-native
    // (`claude --resume`) — but an override must take the agent path so the
    // axes actually apply.
    const { client, registry, calls, close } = await buildHarness({
      routeSelection: "free",
    })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })
    prev.resumeMetadata = { claudeResumeId: "0e483f81-1a44-4bec-9667-b37158450296" }
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: {
        idOrName: prev.id,
        model: "claude-opus-4-8",
        effort: "high",
        posture: "plan",
        route: { gateway: "moonshot" },
        contextProfile: "lean",
      },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    // Agent path (not the pty-native `claude --resume`).
    expect(desc.kind).toBe("agent-cli")
    expect(calls).toHaveLength(1)
    expect(desc.model).toBe("claude-opus-4-8")
    expect(desc.effort).toBe("high")
    expect(desc.posture).toBe("plan")
    expect(desc.route).toEqual({ gateway: "moonshot" })
    expect(desc.contextProfile).toBe("lean")
    expect(desc.routeSelection).toBe("free")
    expect(calls[0]).toMatchObject({ posture: "plan", contextProfile: "lean" })

    await close()
    registry.shutdown()
  })

  it("an unknown access-profile override is rejected as a 400 (SPEC Rx/Ry surface)", async () => {
    const { client, registry, calls, close } = await buildHarness()
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })
    registry.kill(prev.id)
    const before = registry.list().length

    const result = await client.callTool({
      name: "session_restart",
      arguments: {
        idOrName: prev.id,
        access: { profileRef: "definitely-not-a-real-profile-xyz-9001" },
      },
    })
    expect(result.isError).toBe(true)
    const err = toolJson(result)
    expect(err.status).toBe(400)
    expect(err.error).toBe("restart_override_invalid")
    // No new session spawned — rejected before startSession.
    expect(calls).toHaveLength(0)
    expect(registry.list()).toHaveLength(before)

    await close()
    registry.shutdown()
  })

  it("restart-with-override on a non-agent (PTY) session is a 400", async () => {
    const { client, registry, close } = await buildHarness()
    const prev = registry.spawnPty({
      argv: ["bash"],
      cwd: process.cwd(),
      workspaceSlug: "default",
      cols: 80,
      rows: 24,
    })
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id, effort: "high" },
    })
    expect(result.isError).toBe(true)
    const err = toolJson(result)
    expect(err.status).toBe(400)
    expect(err.error).toBe("restart_override_invalid")

    await close()
    registry.shutdown()
  })
})
