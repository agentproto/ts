/**
 * Per-call human approval on imported-MCP tool calls, scoped by a
 * `.agentproto/hooks.json` rule (`{"match":{"tool":"send_message"},"action":"hold"}`).
 *
 * Two layers under test:
 *   - `registry.requestToolPermission` - a daemon-originated permission that
 *     lives in the SAME pending-permissions inbox as an ACP
 *     `session/request_permission` (permissions_list / permissions_respond,
 *     `session:permission-request` on the bus), but has no driver RPC behind
 *     it: resolving it resumes the daemon-side caller.
 *   - `createImportedCallGuard` + `McpProxyRegistry.setCallGuard` - the seam
 *     every imported-MCP call goes through (mcp_imported_call, the
 *     /mcp/imported/<id> passthrough, transmit_message, app_tool_call).
 *
 * The default (no hooks.json, or a rule that does not match) must be a
 * byte-for-byte no-op: the call reaches the upstream with no pending entry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike, type SessionsRegistry } from "../sessions.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import { McpProxyRegistry } from "../mcp-proxy.js"
import { createImportedCallGuard } from "../imported-call-gate.js"

function writeHooks(workspace: string, rules: unknown[]): void {
  mkdirSync(join(workspace, ".agentproto"), { recursive: true })
  writeFileSync(join(workspace, ".agentproto", "hooks.json"), JSON.stringify({ version: 1, rules }))
}

const HOLD_SEND_MESSAGE = {
  id: "hold-send-message",
  plane: "semantic",
  match: { tool: "send_message" },
  action: "hold",
}

async function waitForPending(registry: SessionsRegistry, n = 1): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (registry.listPendingPermissions().length >= n) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error("no pending permission appeared")
}

describe("registry.requestToolPermission", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tool-perm-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("parks a daemon-originated permission in the shared inbox and announces it on the bus", async () => {
    const bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(e => events.push(e))
    const registry = createSessionsRegistry({ persist: false, transcriptDir: join(tmp, "s"), sessionEvents: bus })

    const outcome = registry.requestToolPermission({
      toolName: "send_message",
      text: 'Allow "send_message" on agentpush?',
      rawInput: { to: "x", text: "hi" },
    })
    await waitForPending(registry)

    const [pending] = registry.listPendingPermissions()
    expect(pending).toMatchObject({ toolName: "send_message", rawInput: { to: "x", text: "hi" } })
    expect(pending!.options.map(o => o.kind)).toEqual(["allow_once", "reject_once"])
    expect(events.find(e => e.type === "session:permission-request")).toMatchObject({
      permissionId: pending!.id,
      toolName: "send_message",
    })

    const res = await registry.respondPermission(pending!.id, { decision: "approve" })
    expect(res).toMatchObject({ ok: true, decision: "approve", optionId: "allow_once" })
    await expect(outcome).resolves.toMatchObject({ decision: "approve" })
    expect(registry.listPendingPermissions()).toHaveLength(0)
    expect(events.find(e => e.type === "session:permission-resolved")).toMatchObject({
      permissionId: pending!.id,
      decision: "approve",
    })
    registry.shutdown()
  })

  it("resolves as deny on reject_once", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir: join(tmp, "s") })
    const outcome = registry.requestToolPermission({ toolName: "send_message", text: "?" })
    await waitForPending(registry)
    const [pending] = registry.listPendingPermissions()
    await registry.respondPermission(pending!.id, { decision: "deny" })
    await expect(outcome).resolves.toMatchObject({ decision: "deny" })
    registry.shutdown()
  })

  it("never turns allow-always into a standing grant: scope:always still resolves allow_once", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir: join(tmp, "s") })
    const outcome = registry.requestToolPermission({ toolName: "send_message", text: "?" })
    await waitForPending(registry)
    const [pending] = registry.listPendingPermissions()
    const res = await registry.respondPermission(pending!.id, { decision: "approve", scope: "always" })
    expect(res).toMatchObject({ ok: true, optionId: "allow_once" })
    await outcome
    registry.shutdown()
  })

  it("fails closed on timeout and clears the inbox entry", async () => {
    const bus = createSessionEventBus()
    const events: SessionEvent[] = []
    bus.onAny(e => events.push(e))
    const registry = createSessionsRegistry({ persist: false, transcriptDir: join(tmp, "s"), sessionEvents: bus })
    const outcome = await registry.requestToolPermission({ toolName: "send_message", text: "?", timeoutMs: 30 })
    expect(outcome).toMatchObject({ decision: "cancelled", reason: "timeout" })
    expect(registry.listPendingPermissions()).toHaveLength(0)
    expect(events.find(e => e.type === "session:permission-resolved")).toMatchObject({ decision: "cancelled" })
    registry.shutdown()
  })

  it("persists the cleared awaitingPermission flag when a gate times out", async () => {
    const persistPath = join(tmp, "sessions.json")
    const registry = createSessionsRegistry({ persistPath, transcriptDir: join(tmp, "s") })
    const fake: AgentSessionLike = {
      sessionId: "acp-t",
      pid: 1,
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = registry.spawnAgent({ workspaceSlug: "default", cwd: tmp, agentSession: fake, adapterSlug: "claude-code" })
    const outcome = await registry.requestToolPermission({ sessionId: desc.id, toolName: "send_message", text: "?", timeoutMs: 1800 })
    expect(outcome).toMatchObject({ decision: "cancelled", reason: "timeout" })
    expect(registry.get(desc.id)?.awaitingPermission).toBeFalsy()

    await new Promise(r => setTimeout(r, 1900))
    const onDisk = JSON.parse(readFileSync(persistPath, "utf8")) as { sessions: Array<{ id: string; awaitingPermission?: boolean }> }
    expect(onDisk.sessions.find(s => s.id === desc.id)?.awaitingPermission).toBeFalsy()
    registry.shutdown()
  })

  it("cancels (fails closed) when its owning session dies, and flags the session while parked", async () => {
    const registry = createSessionsRegistry({ persist: false, transcriptDir: join(tmp, "s") })
    const fake: AgentSessionLike = {
      sessionId: "acp-x",
      pid: 1,
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = registry.spawnAgent({ workspaceSlug: "default", cwd: tmp, agentSession: fake, adapterSlug: "claude-code" })
    const outcome = registry.requestToolPermission({ sessionId: desc.id, toolName: "send_message", text: "?" })
    await waitForPending(registry)
    expect(registry.get(desc.id)?.awaitingPermission).toBe(true)
    expect(registry.listPendingPermissions({ sessionId: desc.id })).toHaveLength(1)

    registry.kill(desc.id)
    await expect(outcome).resolves.toMatchObject({ decision: "cancelled" })
    expect(registry.listPendingPermissions()).toHaveLength(0)
    registry.shutdown()
  })
})

describe("createImportedCallGuard on McpProxyRegistry", () => {
  let tmp: string
  let workspace: string
  let registry: SessionsRegistry
  let proxy: McpProxyRegistry
  let upstream: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "imported-gate-"))
    workspace = join(tmp, "ws")
    mkdirSync(workspace, { recursive: true })
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(tmp, "s") })
    proxy = new McpProxyRegistry()
    upstream = vi.fn(async () => ({ content: [{ type: "text", text: "sent" }] }))
    vi.spyOn(proxy as never, "connectIfNeeded" as never).mockImplementation((async () => ({
      entry: {},
      client: { callTool: upstream },
      tools: [],
      lastError: null,
    })) as never)
    proxy.setCallGuard(createImportedCallGuard({ registry, workspace, timeoutMs: 2_000 }))
  })
  afterEach(() => {
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("is a no-op without a hooks.json: the call reaches the upstream, nothing is parked", async () => {
    const out = await proxy.callTool("agentpush", "send_message", { text: "hi" })
    expect(out).toMatchObject({ ok: true })
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(registry.listPendingPermissions()).toHaveLength(0)
  })

  it("holds a matching send_message until a human approves, then forwards the original args", async () => {
    writeHooks(workspace, [HOLD_SEND_MESSAGE])
    const call = proxy.callTool("agentpush", "send_message", { to: "jeremy", text: "hello" })
    await waitForPending(registry)

    expect(upstream).not.toHaveBeenCalled()
    const [pending] = registry.listPendingPermissions()
    expect(pending).toMatchObject({ toolName: "send_message" })
    expect(pending!.rawInput).toMatchObject({ alias: "agentpush", toolName: "send_message", args: { to: "jeremy", text: "hello" } })

    await registry.respondPermission(pending!.id, { decision: "approve" })
    await expect(call).resolves.toMatchObject({ ok: true })
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(upstream).toHaveBeenCalledWith({ name: "send_message", arguments: { to: "jeremy", text: "hello" } })
  })

  it("never calls the upstream when the human rejects", async () => {
    writeHooks(workspace, [HOLD_SEND_MESSAGE])
    const call = proxy.callTool("agentpush", "send_message", { text: "hello" })
    await waitForPending(registry)
    const [pending] = registry.listPendingPermissions()
    await registry.respondPermission(pending!.id, { decision: "deny" })

    const out = await call
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error).toMatch(/rejected/i)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("never calls the upstream when the approval times out", async () => {
    writeHooks(workspace, [HOLD_SEND_MESSAGE])
    proxy.setCallGuard(createImportedCallGuard({ registry, workspace, timeoutMs: 30 }))
    const out = await proxy.callTool("agentpush", "send_message", { text: "hello" })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error).toMatch(/timed out/i)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("leaves every other imported tool untouched while the send_message rule is active", async () => {
    writeHooks(workspace, [HOLD_SEND_MESSAGE])
    for (const tool of ["poll_inbound", "upload_media", "list_contacts", "send_message_draft"]) {
      const out = await proxy.callTool("agentpush", tool, {})
      expect(out).toMatchObject({ ok: true })
    }
    expect(upstream).toHaveBeenCalledTimes(4)
    expect(registry.listPendingPermissions()).toHaveLength(0)
  })

  it("scopes by alias when the rule uses the imported:<alias>/<tool> form", async () => {
    writeHooks(workspace, [
      { id: "hold-agentpush-send", plane: "semantic", match: { tool: "imported:agentpush/send_message" }, action: "hold" },
    ])
    const other = await proxy.callTool("slack-ish", "send_message", { text: "x" })
    expect(other).toMatchObject({ ok: true })
    expect(registry.listPendingPermissions()).toHaveLength(0)

    const held = proxy.callTool("agentpush", "send_message", { text: "x" })
    await waitForPending(registry)
    const [pending] = registry.listPendingPermissions()
    await registry.respondPermission(pending!.id, { decision: "approve" })
    await expect(held).resolves.toMatchObject({ ok: true })
  })

  it("ignores log-only rules (they never change a decision)", async () => {
    writeHooks(workspace, [{ ...HOLD_SEND_MESSAGE, action: "log" }])
    const out = await proxy.callTool("agentpush", "send_message", { text: "hi" })
    expect(out).toMatchObject({ ok: true })
    expect(registry.listPendingPermissions()).toHaveLength(0)
  })

  it("treats a deny rule as a human hold at this seam: parked, never auto-denied, never sent unless approved", async () => {
    writeHooks(workspace, [{ ...HOLD_SEND_MESSAGE, id: "deny-send-message", action: "deny" }])
    const call = proxy.callTool("agentpush", "send_message", { text: "hello" })
    await waitForPending(registry)
    expect(upstream).not.toHaveBeenCalled()
    const [pending] = registry.listPendingPermissions()
    expect(pending!.options.map(o => o.optionId)).toEqual(["allow_once", "reject_once"])

    await registry.respondPermission(pending!.id, { decision: "deny" })
    const out = await call
    expect(out.ok).toBe(false)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("treats a gate rule as a human hold at this seam: the gate command is never run", async () => {
    const marker = join(tmp, "gate-ran")
    writeHooks(workspace, [
      {
        ...HOLD_SEND_MESSAGE,
        id: "gate-send-message",
        action: "gate",
        gate: { command: "sh", args: ["-c", `touch ${marker}`] },
      },
    ])
    const call = proxy.callTool("agentpush", "send_message", { text: "hello" })
    await waitForPending(registry)
    expect(upstream).not.toHaveBeenCalled()
    const [pending] = registry.listPendingPermissions()
    await registry.respondPermission(pending!.id, { decision: "approve" })
    await expect(call).resolves.toMatchObject({ ok: true })
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(existsSync(marker)).toBe(false)
  })

  it("reads the rule from the calling session's cwd, attributing the permission to that session", async () => {
    const sessionWs = join(tmp, "session-ws")
    mkdirSync(sessionWs, { recursive: true })
    writeHooks(sessionWs, [HOLD_SEND_MESSAGE])
    const fake: AgentSessionLike = {
      sessionId: "acp-y",
      pid: 2,
      async *send() {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = registry.spawnAgent({ workspaceSlug: "default", cwd: sessionWs, agentSession: fake, adapterSlug: "claude-code" })

    const call = proxy.callTool("agentpush", "send_message", { text: "hi" }, { callerSessionId: desc.id })
    await waitForPending(registry)
    expect(registry.listPendingPermissions({ sessionId: desc.id })).toHaveLength(1)
    const [pending] = registry.listPendingPermissions()
    await registry.respondPermission(pending!.id, { decision: "approve" })
    await expect(call).resolves.toMatchObject({ ok: true })
  })
})
