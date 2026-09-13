/**
 * Cross-session pending-permissions inbox — permission-hold mode end-to-end.
 *
 * A session spawned with `permissionHold` surfaces each ACP
 * `session/request_permission` as an `agent-prompt` StreamEvent and PARKS the
 * driver RPC. This exercises the full daemon-side loop over a scripted fake
 * driver session:
 *   - registry.listPendingPermissions reflects the parked request
 *   - registry.respondPermission maps approve/deny (+ scope + explicit
 *     optionId) onto the offered option, resolves the held RPC, clears state
 *   - session death auto-cancels pending requests (no dangling RPC)
 *   - session:permission-request / -resolved fire on the bus
 *   - the MCP tools (permissions_list / permissions_respond) and REST routes
 *     (GET /permissions, POST /permissions/:id) drive the same inbox
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "@agentproto/mcp-server"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type SessionsRegistry,
} from "../sessions.js"
import { sessionEventsPath } from "../transcript-writer.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import { registerOrchestrationTools } from "../orchestration-tools.js"
import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const OPTIONS = [
  { optionId: "opt-once", name: "Allow once", kind: "allow_once" },
  { optionId: "opt-always", name: "Allow always", kind: "allow_always" },
  { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
]

/** Fake driver session that surfaces one held permission, then blocks until
 *  the registry resolves it (records the resolution), then ends the turn. */
function holdSession(
  acpId = "acp-hold",
  requestId = "perm-1",
  rawInput?: unknown,
  toolName = "Write",
  meta?: unknown,
): {
  session: AgentSessionLike
  responded: Array<{ requestId: string; resolution: unknown }>
} {
  const responded: Array<{ requestId: string; resolution: unknown }> = []
  let release: (() => void) | null = null
  const session: AgentSessionLike = {
    sessionId: acpId,
    pid: 4242,
    async *send() {
      yield {
        kind: "agent-prompt",
        toolCallId: requestId,
        toolName,
        text: `Allow "${toolName}"?`,
        options: OPTIONS,
        ...(rawInput !== undefined ? { rawInput } : {}),
        ...(meta !== undefined ? { _meta: meta } : {}),
      }
      await new Promise<void>(r => {
        release = r
      })
      yield { kind: "turn-end", reason: "completed" }
    },
    respondPermission(id, resolution) {
      responded.push({ requestId: id, resolution })
      release?.()
      return true
    },
    async cancel() {},
    async close() {
      // Unblock the generator so a kill()-driven close doesn't hang the turn.
      release?.()
    },
  }
  return { session, responded }
}

/** Spawn a permission-hold session, kick the turn (do NOT await — it blocks on
 *  the permission), and wait until the request is parked. */
async function spawnAndPark(
  registry: SessionsRegistry,
  fake: { session: AgentSessionLike },
): Promise<string> {
  const desc = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: fake.session,
    adapterSlug: "claude-code",
    permissionHold: true,
    label: "held-session",
  })
  void registry.sendPrompt(desc.id, "go").catch(() => {})
  // Poll until the agent-prompt has been projected + registered.
  for (let i = 0; i < 100; i++) {
    if (registry.listPendingPermissions({ sessionId: desc.id }).length > 0) break
    await new Promise(r => setTimeout(r, 5))
  }
  return desc.id
}

/** Read a session's durable structured-transcript records (events.jsonl),
 *  parsed one JSON object per line — same file the book view reads. */
function readTranscript(transcriptDir: string, sessionId: string): Array<Record<string, unknown>> {
  const path = sessionEventsPath(sessionId, transcriptDir)
  if (!existsSync(path)) return []
  const out: Array<Record<string, unknown>> = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    out.push(JSON.parse(trimmed) as Record<string, unknown>)
  }
  return out
}

describe("pending-permissions inbox — registry", () => {
  let tmp: string
  let transcriptDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pending-perms-"))
    transcriptDir = join(tmp, "sessions")
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("registers a held permission and lists it with the offered options", async () => {
    const bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(e => events.push(e))
    const registry = createSessionsRegistry({ persist: false, transcriptDir, sessionEvents: bus })
    const fake = holdSession()
    const id = await spawnAndPark(registry, fake)

    const pending = registry.listPendingPermissions()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      id: "perm-1",
      sessionId: id,
      toolName: "Write",
      text: 'Allow "Write"?',
    })
    expect(pending[0]!.options.map(o => o.optionId)).toEqual([
      "opt-once",
      "opt-always",
      "opt-reject",
    ])
    // The session descriptor flags the held state for the CLI badge.
    expect(registry.get(id)?.awaitingPermission).toBe(true)
    // Bus announced the request.
    const req = events.find(e => e.type === "session:permission-request")
    expect(req).toMatchObject({ sessionId: id, permissionId: "perm-1", toolName: "Write" })

    registry.shutdown()
  })

  it("carries a Bash tool call's rawInput (command string) through to the pending permission", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const fake = holdSession("acp-raw", "perm-raw", { command: "rm -rf /tmp/x" })
    const id = await spawnAndPark(registry, fake)

    const pending = registry.listPendingPermissions()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      id: "perm-raw",
      sessionId: id,
      rawInput: { command: "rm -rf /tmp/x" },
    })

    registry.shutdown()
  })

  it("carries the tool call's _meta (e.g. a mastra suspension payload) through to the pending permission", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const meta = { "mastra-agent/suspendPayload": { plan: "1. do things\n2. push" } }
    const fake = holdSession("acp-meta", "perm-meta", { plan: "1. do things\n2. push" }, "submit_plan", meta)
    const id = await spawnAndPark(registry, fake)

    const pending = registry.listPendingPermissions()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: "perm-meta", sessionId: id, _meta: meta })

    registry.shutdown()
  })

  it("threads feedback through respondPermission onto the driver resolution", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const fake = holdSession("acp-fb", "perm-fb")
    await spawnAndPark(registry, fake)
    const r = await registry.respondPermission("perm-fb", {
      decision: "deny",
      feedback: "reject, but do X instead",
    })
    expect(r.ok).toBe(true)
    expect(fake.responded).toEqual([
      { requestId: "perm-fb", resolution: { optionId: "opt-reject", feedback: "reject, but do X instead" } },
    ])
    registry.shutdown()
  })

  it("approve → allow_once, scope:always → allow_always, deny → reject_once", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })

    // approve (default scope) → allow_once
    const a = holdSession("acp-a", "perm-a")
    const idA = await spawnAndPark(registry, a)
    const rA = await registry.respondPermission("perm-a", { decision: "approve" })
    expect(rA.ok).toBe(true)
    expect(a.responded).toEqual([{ requestId: "perm-a", resolution: { optionId: "opt-once" } }])
    expect(registry.listPendingPermissions()).toHaveLength(0)
    expect(registry.get(idA)?.awaitingPermission).toBeUndefined()

    // approve scope:always → allow_always
    const b = holdSession("acp-b", "perm-b")
    await spawnAndPark(registry, b)
    await registry.respondPermission("perm-b", { decision: "approve", scope: "always" })
    expect(b.responded).toEqual([{ requestId: "perm-b", resolution: { optionId: "opt-always" } }])

    // deny → reject_once
    const c = holdSession("acp-c", "perm-c")
    await spawnAndPark(registry, c)
    await registry.respondPermission("perm-c", { decision: "deny" })
    expect(c.responded).toEqual([{ requestId: "perm-c", resolution: { optionId: "opt-reject" } }])

    registry.shutdown()
  })

  it("an explicit optionId overrides the decision→option mapping", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const fake = holdSession("acp-x", "perm-x")
    await spawnAndPark(registry, fake)
    const r = await registry.respondPermission("perm-x", { decision: "deny", optionId: "opt-always" })
    expect(r.ok).toBe(true)
    expect(fake.responded).toEqual([{ requestId: "perm-x", resolution: { optionId: "opt-always" } }])
    registry.shutdown()
  })

  it("emits session:permission-resolved on a successful response", async () => {
    const bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(e => events.push(e))
    const registry = createSessionsRegistry({ persist: false, transcriptDir, sessionEvents: bus })
    const fake = holdSession("acp-r", "perm-r")
    const id = await spawnAndPark(registry, fake)
    await registry.respondPermission("perm-r", { decision: "approve" })
    const resolved = events.find(e => e.type === "session:permission-resolved")
    expect(resolved).toMatchObject({
      sessionId: id,
      permissionId: "perm-r",
      decision: "approve",
      optionId: "opt-once",
    })
    registry.shutdown()
  })

  it("writes a durable permission-resolved record to the session transcript, keyed by toolCallId", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const fake = holdSession("acp-transcript", "perm-t")
    const id = await spawnAndPark(registry, fake)
    await registry.respondPermission("perm-t", { decision: "approve" })

    // The write stream flushes asynchronously — poll rather than assume
    // it's already durable the instant respondPermission resolves.
    let records: Array<Record<string, unknown>> = []
    for (let i = 0; i < 100; i++) {
      records = readTranscript(transcriptDir, id)
      if (records.some(r => r.kind === "permission-resolved")) break
      await new Promise(r => setTimeout(r, 5))
    }
    const ask = records.find(r => r.kind === "agent-prompt")
    const resolved = records.find(r => r.kind === "permission-resolved")
    expect(ask).toMatchObject({ toolCallId: "perm-t" })
    expect(resolved).toMatchObject({ toolCallId: "perm-t", decision: "approve", optionId: "opt-once" })

    registry.shutdown()
  })

  it("errors clearly on an unknown / already-resolved id", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const r1 = await registry.respondPermission("nope", { decision: "approve" })
    expect(r1).toMatchObject({ ok: false, error: "not_found" })

    const fake = holdSession("acp-d", "perm-d")
    await spawnAndPark(registry, fake)
    await registry.respondPermission("perm-d", { decision: "approve" })
    const r2 = await registry.respondPermission("perm-d", { decision: "approve" })
    expect(r2).toMatchObject({ ok: false, error: "not_found" })
    registry.shutdown()
  })

  it("session death auto-cancels every parked request (no dangling RPC)", async () => {
    const bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(e => events.push(e))
    const registry = createSessionsRegistry({ persist: false, transcriptDir, sessionEvents: bus })
    const fake = holdSession("acp-k", "perm-k")
    const id = await spawnAndPark(registry, fake)
    expect(registry.listPendingPermissions()).toHaveLength(1)

    registry.kill(id)

    expect(registry.listPendingPermissions()).toHaveLength(0)
    expect(fake.responded).toEqual([{ requestId: "perm-k", resolution: { cancelled: true } }])
    const resolved = events.find(
      e => e.type === "session:permission-resolved" && e.permissionId === "perm-k",
    )
    expect(resolved).toMatchObject({ decision: "cancelled" })

    let records: Array<Record<string, unknown>> = []
    for (let i = 0; i < 100; i++) {
      records = readTranscript(transcriptDir, id)
      if (records.some(r => r.kind === "permission-resolved")) break
      await new Promise(r => setTimeout(r, 5))
    }
    expect(records.find(r => r.kind === "permission-resolved")).toMatchObject({
      toolCallId: "perm-k",
      decision: "cancelled",
    })

    registry.shutdown()
  })
})

// ── action:"gate" auto-resolve (PR 5 — the git-push hook) ────────────────
//
// A `.agentproto/hooks.json` rule with `action:"gate"` (e.g. the canonical
// `git push` → review-gate example from hooks-config.ts's module docblock)
// doesn't wait on a human: it parks the request like a "hold" (so a dying
// session still gets cancelled cleanly), runs the configured shell command,
// and resolves the SAME held driver RPC itself from that command's exit
// code — approve on 0, deny otherwise. This exercises that path against a
// real (fast, allowlisted) subprocess rather than mocking runShellGate.

function writeGateWorkspace(dir: string, gateExitCode: number): void {
  mkdirSync(join(dir, ".agentproto"), { recursive: true })
  writeFileSync(
    join(dir, ".agentproto", "hooks.json"),
    JSON.stringify({
      version: 1,
      rules: [
        {
          id: "git-push-review-gate",
          plane: "semantic",
          match: { tool: "Bash", command: "^git push" },
          action: "gate",
          gate: { command: "node", args: ["-e", `process.exit(${gateExitCode})`] },
        },
      ],
    }),
  )
  writeFileSync(
    join(dir, ".agentproto", "allowed-commands.json"),
    JSON.stringify({ version: 1, commands: ["node"] }),
  )
}

/** Spawn a (non-hold) session in `cwd`, kick the turn, and wait for the
 *  gate rule to park + auto-resolve the request. Returns the session id. */
async function spawnAndAwaitGateResolution(
  registry: SessionsRegistry,
  fake: { session: AgentSessionLike; responded: Array<{ requestId: string; resolution: unknown }> },
  cwd: string,
): Promise<string> {
  const desc = registry.spawnAgent({
    workspaceSlug: "default",
    cwd,
    agentSession: fake.session,
    adapterSlug: "claude-code",
    label: "gated-session",
  })
  void registry.sendPrompt(desc.id, "go").catch(() => {})
  for (let i = 0; i < 300; i++) {
    if (fake.responded.length > 0) break
    await new Promise(r => setTimeout(r, 10))
  }
  return desc.id
}

describe('pending-permissions inbox — action:"gate" auto-resolve', () => {
  let tmp: string
  let transcriptDir: string
  let workspace: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gate-hook-"))
    transcriptDir = join(tmp, "sessions")
    workspace = join(tmp, "workspace")
    mkdirSync(workspace, { recursive: true })
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("a passing gate (exit 0) auto-approves the git push", async () => {
    writeGateWorkspace(workspace, 0)
    const bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(e => events.push(e))
    const registry = createSessionsRegistry({ persist: false, transcriptDir, sessionEvents: bus })
    const fake = holdSession("acp-gate-ok", "perm-gate-ok", { command: "git push origin main" }, "Bash")

    const id = await spawnAndAwaitGateResolution(registry, fake, workspace)

    expect(fake.responded).toEqual([
      { requestId: "perm-gate-ok", resolution: { optionId: "opt-once" } },
    ])
    expect(registry.listPendingPermissions()).toHaveLength(0)
    expect(registry.get(id)?.awaitingPermission).toBeUndefined()
    const resolved = events.find(e => e.type === "session:permission-resolved")
    expect(resolved).toMatchObject({ permissionId: "perm-gate-ok", decision: "approve" })

    registry.shutdown()
  })

  it("a failing gate (nonzero exit) auto-denies the git push", async () => {
    writeGateWorkspace(workspace, 1)
    const bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(e => events.push(e))
    const registry = createSessionsRegistry({ persist: false, transcriptDir, sessionEvents: bus })
    const fake = holdSession("acp-gate-fail", "perm-gate-fail", { command: "git push origin main" }, "Bash")

    await spawnAndAwaitGateResolution(registry, fake, workspace)

    expect(fake.responded).toEqual([
      { requestId: "perm-gate-fail", resolution: { optionId: "opt-reject" } },
    ])
    expect(registry.listPendingPermissions()).toHaveLength(0)
    const resolved = events.find(e => e.type === "session:permission-resolved")
    expect(resolved).toMatchObject({ permissionId: "perm-gate-fail", decision: "deny" })

    registry.shutdown()
  })

  it("a non-matching Bash command (git status) is unaffected — no gate runs, no hold", async () => {
    writeGateWorkspace(workspace, 0)
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const fake = holdSession("acp-gate-skip", "perm-gate-skip", { command: "git status" }, "Bash")

    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: workspace,
      agentSession: fake.session,
      adapterSlug: "claude-code",
      label: "ungated-session",
    })
    void registry.sendPrompt(desc.id, "go").catch(() => {})
    // A non-matching command falls through to fallback ("allow" — no
    // permissionHold here), so nothing is ever parked and the driver's
    // respondPermission is never called; give the async turn a moment to
    // settle rather than polling for an event that shouldn't happen.
    await new Promise(r => setTimeout(r, 50))

    expect(registry.listPendingPermissions()).toHaveLength(0)
    expect(fake.responded).toEqual([])

    registry.shutdown()
  })
})

// ── MCP transport ─────────────────────────────────────────────────────

describe("pending-permissions inbox — MCP tools", () => {
  let tmp: string
  let transcriptDir: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pending-perms-mcp-"))
    transcriptDir = join(tmp, "sessions")
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  function parse(result: unknown): any {
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content
    const text = content?.find(c => c.type === "text")?.text
    if (!text) throw new Error("tool returned no text content")
    return JSON.parse(text)
  }

  it("permissions_list shows the request and permissions_respond resolves it", async () => {
    const bus = createSessionEventBus()
    const eventRing = createEventRing()
    const registry = createSessionsRegistry({ persist: false, transcriptDir, sessionEvents: bus })
    const fake = holdSession("acp-mcp", "perm-mcp", { command: "git push --force" })
    const id = await spawnAndPark(registry, fake)

    const server = new McpServer({ name: "perms-mcp", version: "0.0.0" })
    registerOrchestrationTools(server, { registry, sessionEvents: bus, eventRing })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: "perms-mcp-client", version: "0.0.0" })
    await client.connect(ct)

    const listed = parse(await client.callTool({ name: "permissions_list", arguments: {} }))
    expect(listed.permissions).toHaveLength(1)
    expect(listed.permissions[0]).toMatchObject({
      id: "perm-mcp",
      sessionId: id,
      adapter: "claude-code",
      toolName: "Write",
      rawInput: { command: "git push --force" },
    })

    const responded = parse(
      await client.callTool({
        name: "permissions_respond",
        arguments: { id: "perm-mcp", decision: "approve" },
      }),
    )
    expect(responded).toMatchObject({ ok: true, id: "perm-mcp", decision: "approve", optionId: "opt-once" })
    expect(fake.responded).toEqual([{ requestId: "perm-mcp", resolution: { optionId: "opt-once" } }])
    expect(registry.listPendingPermissions()).toHaveLength(0)

    registry.shutdown()
  })

  it("permissions_list: page-walk with limit=2 covers exactly the unpaginated scoped list", async () => {
    const bus = createSessionEventBus()
    const eventRing = createEventRing()
    const registry = createSessionsRegistry({ persist: false, transcriptDir, sessionEvents: bus })
    const requestIds = ["perm-walk-1", "perm-walk-2", "perm-walk-3"]
    for (const requestId of requestIds) {
      await spawnAndPark(registry, holdSession(`acp-${requestId}`, requestId, { command: "git push --force" }))
    }

    const server = new McpServer({ name: "perms-mcp-page", version: "0.0.0" })
    registerOrchestrationTools(server, { registry, sessionEvents: bus, eventRing })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: "perms-mcp-page-client", version: "0.0.0" })
    await client.connect(ct)

    // Default call unchanged: the pre-pagination envelope, no page fields.
    const unpaginated = parse(await client.callTool({ name: "permissions_list", arguments: {} }))
    expect(unpaginated.permissions).toHaveLength(3)
    expect(unpaginated.total).toBeUndefined()
    expect(unpaginated.items).toBeUndefined()

    // Page-walk: the union of pages equals the unpaginated scoped list exactly.
    const union: Array<{ id: string }> = []
    let cursor: string | undefined
    do {
      const page = parse(
        await client.callTool({
          name: "permissions_list",
          arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
        }),
      )
      expect(page.total).toBe(3)
      union.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    expect(union.map(p => p.id)).toEqual(unpaginated.permissions.map((p: { id: string }) => p.id))

    registry.shutdown()
  })

  it("permissions_list: a scoped caller's page total reflects subtree scoping — paginate runs AFTER scoping", async () => {
    const bus = createSessionEventBus()
    const eventRing = createEventRing()
    const registry = createSessionsRegistry({ persist: false, transcriptDir, sessionEvents: bus })
    // Three parked sessions; the scope owner is the first. collectSubtree
    // over root sessions yields only the owner itself, so the scoped view
    // holds exactly ONE permission even though three are parked.
    const requestIds = ["perm-scope-1", "perm-scope-2", "perm-scope-3"]
    const ids: string[] = []
    for (const requestId of requestIds) {
      ids.push(
        await spawnAndPark(registry, holdSession(`acp-${requestId}`, requestId, { command: "git push --force" })),
      )
    }

    const server = new McpServer({ name: "perms-mcp-scope", version: "0.0.0" })
    registerOrchestrationTools(server, {
      registry,
      sessionEvents: bus,
      eventRing,
      callerScope: { ownerSessionId: ids[0] },
    })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: "perms-mcp-scope-client", version: "0.0.0" })
    await client.connect(ct)

    const unpaginated = parse(await client.callTool({ name: "permissions_list", arguments: {} }))
    expect(unpaginated.permissions).toHaveLength(1)

    const union: Array<{ id: string }> = []
    let cursor: string | undefined
    do {
      const page = parse(
        await client.callTool({
          name: "permissions_list",
          arguments: { limit: 1, ...(cursor ? { cursor } : {}) },
        }),
      )
      // total=1 (the scoped set), NOT 3 — pagination never sees the rows
      // scoping already removed.
      expect(page.total).toBe(1)
      union.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    expect(union.map(p => p.id)).toEqual(unpaginated.permissions.map((p: { id: string }) => p.id))

    registry.shutdown()
  })

  it("permissions_respond errors on an unknown id", async () => {
    const bus = createSessionEventBus()
    const eventRing = createEventRing()
    const registry = createSessionsRegistry({ persist: false, transcriptDir, sessionEvents: bus })
    const server = new McpServer({ name: "perms-mcp2", version: "0.0.0" })
    registerOrchestrationTools(server, { registry, sessionEvents: bus, eventRing })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: "perms-mcp2-client", version: "0.0.0" })
    await client.connect(ct)

    const res = await client.callTool({
      name: "permissions_respond",
      arguments: { id: "ghost", decision: "deny" },
    })
    expect((res as { isError?: boolean }).isError).toBe(true)
    expect(parse(res)).toMatchObject({ error: "not_found" })
    registry.shutdown()
  })
})

// ── REST transport ────────────────────────────────────────────────────

describe("pending-permissions inbox — REST routes", () => {
  let tmp: string
  let transcriptDir: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pending-perms-http-"))
    transcriptDir = join(tmp, "sessions")
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  async function withServer(
    registry: SessionsRegistry,
    fn: (base: string) => Promise<void>,
  ): Promise<void> {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("GET /permissions lists and POST /permissions/:id resolves", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const fake = holdSession("acp-http", "perm-http")
    const id = await spawnAndPark(registry, fake)

    await withServer(registry, async base => {
      const listRes = await fetch(`${base}/permissions`)
      expect(listRes.status).toBe(200)
      const list = (await listRes.json()) as { permissions: Array<Record<string, unknown>> }
      expect(list.permissions).toHaveLength(1)
      expect(list.permissions[0]).toMatchObject({ id: "perm-http", sessionId: id, adapter: "claude-code" })

      const postRes = await fetch(`${base}/permissions/perm-http`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve", scope: "always" }),
      })
      expect(postRes.status).toBe(200)
      const body = (await postRes.json()) as Record<string, unknown>
      expect(body).toMatchObject({ ok: true, id: "perm-http", decision: "approve", optionId: "opt-always" })
      expect(fake.responded).toEqual([{ requestId: "perm-http", resolution: { optionId: "opt-always" } }])
    })
    registry.shutdown()
  })

  it("GET /permissions carries the request's _meta and POST forwards feedback", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    const meta = { "mastra-agent/suspendPayload": { plan: "1. do things" } }
    const fake = holdSession("acp-http-meta", "perm-http-meta", undefined, "submit_plan", meta)
    await spawnAndPark(registry, fake)

    await withServer(registry, async base => {
      const listRes = await fetch(`${base}/permissions`)
      const list = (await listRes.json()) as { permissions: Array<Record<string, unknown>> }
      expect(list.permissions[0]).toMatchObject({ id: "perm-http-meta", _meta: meta })

      const postRes = await fetch(`${base}/permissions/perm-http-meta`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "deny", feedback: "do X instead" }),
      })
      expect(postRes.status).toBe(200)
      expect(fake.responded).toEqual([
        { requestId: "perm-http-meta", resolution: { optionId: "opt-reject", feedback: "do X instead" } },
      ])
    })
    registry.shutdown()
  })

  it("POST /permissions/:id 404s on an unknown id and 400s on a bad decision", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir })
    await withServer(registry, async base => {
      const notFound = await fetch(`${base}/permissions/ghost`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      })
      expect(notFound.status).toBe(404)

      const badDecision = await fetch(`${base}/permissions/ghost`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "maybe" }),
      })
      expect(badDecision.status).toBe(400)
    })
    registry.shutdown()
  })
})

// ── tiny stubs (mirror awaiting-question-mcp-e2e.test.ts) ──

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}
