/**
 * cron_create / cron_list / cron_run parity with the scheduler's CronAction
 * union: `kind:"tool"` is exposed (minus cron_* self-scheduling), and an
 * `agent` action IS agent_start's input shape (minus `wait`), fired as a
 * real `agent_start` call, so access.profileRef, role, … need no cron code.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createCronScheduler, type CronJob, type CronScheduler } from "../cron-scheduler.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import { agentStartInputShape } from "../agent-start-schema.js"

type DispatchTool = (name: string, inputs: Record<string, unknown>) => Promise<unknown>

const tmpDirs: string[] = []
const schedulers: CronScheduler[] = []

afterEach(() => {
  for (const s of schedulers.splice(0)) s.shutdown()
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true }) } catch { /* ignore */ }
  }
})

function makeScheduler(opts: { dispatchTool?: DispatchTool; persistPath?: string } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "cron-parity-"))
  tmpDirs.push(workspace)
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const scheduler = createCronScheduler({
    sessionEvents,
    registry,
    workspace,
    ...(opts.dispatchTool ? { dispatchTool: opts.dispatchTool } : {}),
    ...(opts.persistPath ? { persistPath: opts.persistPath } : {}),
  })
  schedulers.push(scheduler)
  return { scheduler, sessionEvents, registry }
}

async function buildClient(
  scheduler: CronScheduler,
  extra: { toolSubset?: ReadonlySet<string> } = {},
): Promise<Client> {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const server = new McpServer({ name: "cron-parity-test", version: "0.0.0" })
  registerOrchestrationTools(server, {
    registry,
    sessionEvents,
    eventRing: createEventRing(),
    cronScheduler: scheduler,
    ...extra,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "cron-parity-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

/** Calls a tool and normalises "rejected" to {isError, text} whether the SDK
 *  surfaces input-validation failure as an error result or a thrown McpError. */
async function call(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text?: string }>
      isError?: boolean
    }
    return { isError: result.isError === true, text: result.content[0]?.text ?? "" }
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err) }
  }
}

const okResult = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] })

describe("cron_create schema — kind:\"tool\"", () => {
  it("accepts a tool action and cron_list (full) returns it", async () => {
    const { scheduler } = makeScheduler()
    const client = await buildClient(scheduler)
    const created = await call(client, "cron_create", {
      schedule: "0 3 * * *",
      action: { kind: "tool", tool: "worktree_gc", inputs: { dryRun: true } },
    })
    expect(created.isError).toBe(false)
    const { jobId } = JSON.parse(created.text) as { jobId: string }

    const listed = await call(client, "cron_list", { full: true })
    const { jobs } = JSON.parse(listed.text) as { jobs: CronJob[] }
    expect(jobs.find(j => j.id === jobId)?.action).toEqual({
      kind: "tool",
      tool: "worktree_gc",
      inputs: { dryRun: true },
    })
  })

  it.each(["cron_create", "cron_run", "cron_delete"])("refuses self-scheduling tool %s", async tool => {
    const { scheduler } = makeScheduler()
    const client = await buildClient(scheduler)
    const res = await call(client, "cron_create", {
      schedule: "* * * * *",
      action: { kind: "tool", tool, inputs: {} },
    })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/self-scheduling/)
    expect(scheduler.list()).toHaveLength(0)
  })

  it("scheduler.create() refuses cron_* even when called directly", () => {
    const { scheduler } = makeScheduler()
    expect(() =>
      scheduler.create({ schedule: "* * * * *", action: { kind: "tool", tool: "cron_create" } }),
    ).toThrow(/self-scheduling/)
  })

  it("a hand-edited persisted cron_* tool job is refused at fire time, never dispatched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-parity-persist-"))
    tmpDirs.push(dir)
    const persistPath = join(dir, "cron-jobs.json")
    writeFileSync(
      persistPath,
      JSON.stringify([
        {
          id: "cron_evil",
          schedule: "0 0 1 1 *",
          recurring: true,
          active: true,
          createdAt: new Date().toISOString(),
          action: { kind: "tool", tool: "cron_create", inputs: {} },
        },
      ]),
    )
    const dispatchTool = vi.fn<DispatchTool>(async () => okResult({}))
    const { scheduler } = makeScheduler({ dispatchTool, persistPath })
    const result = await scheduler.run("cron_evil")
    expect(result?.ok).toBe(false)
    expect(result?.summary).toMatch(/self-scheduling/)
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it("a scoped server (toolSubset) cannot schedule a tool outside its subset", async () => {
    const { scheduler } = makeScheduler()
    const client = await buildClient(scheduler, {
      toolSubset: new Set(["cron_create", "cron_list", "session_list"]),
    })
    const denied = await call(client, "cron_create", {
      schedule: "* * * * *",
      action: { kind: "tool", tool: "command_execute", inputs: {} },
    })
    expect(denied.isError).toBe(true)
    expect(denied.text).toMatch(/not in this server's tool subset/)
    const allowed = await call(client, "cron_create", {
      schedule: "* * * * *",
      action: { kind: "tool", tool: "session_list", inputs: {} },
    })
    expect(allowed.isError).toBe(false)
  })

  it("still rejects an unknown action kind", async () => {
    const { scheduler } = makeScheduler()
    const client = await buildClient(scheduler)
    const res = await call(client, "cron_create", {
      schedule: "* * * * *",
      action: { kind: "nope", tool: "x" },
    })
    expect(res.isError).toBe(true)
  })
})

describe("cron_create schema — agent action is agent_start's own shape", () => {
  const supervisorAction = {
    kind: "agent",
    adapter: "claude-code",
    prompt: "supervise tonight's run",
    access: { profileRef: "claude-subs-agentik" },
    role: "supervisor",
    label: "nightly-supervisor",
    effort: "high",
    worktree: { slug: "nightly", base: "origin/main" },
    keepAlive: true,
    attach: false,
  }

  it("accepts access.profileRef + role (+ the rest) and cron_list returns them", async () => {
    const { scheduler } = makeScheduler()
    const client = await buildClient(scheduler)
    const created = await call(client, "cron_create", {
      schedule: "10 22 * * *",
      recurring: false,
      action: supervisorAction,
    })
    expect(created.isError).toBe(false)
    const { jobId } = JSON.parse(created.text) as { jobId: string }

    const listed = await call(client, "cron_list", { full: true })
    const { jobs } = JSON.parse(listed.text) as { jobs: CronJob[] }
    expect(jobs.find(j => j.id === jobId)?.action).toEqual(supervisorAction)
  })

  it("advertises exactly agent_start's fields (minus wait) on the agent action", async () => {
    const { scheduler } = makeScheduler()
    const client = await buildClient(scheduler)
    const { tools } = await client.listTools()
    const cronCreate = tools.find(t => t.name === "cron_create")!
    const action = (cronCreate.inputSchema.properties as Record<string, { anyOf?: unknown[] }>).action!
    const agentVariant = (action.anyOf as Array<{ properties: Record<string, { const?: unknown }> }>).find(
      v => v.properties.kind?.const === "agent",
    )!
    const expected = Object.keys(agentStartInputShape).filter(k => k !== "wait")
    expect(Object.keys(agentVariant.properties).sort()).toEqual([...expected, "kind"].sort())
  })

  it("rejects what agent_start's schema rejects (empty profileRef, bad worktree slug)", async () => {
    const { scheduler } = makeScheduler()
    const client = await buildClient(scheduler)
    for (const bad of [
      { access: { profileRef: "" } },
      { worktree: { slug: "Not Kebab" } },
      { worktree: { unknownKey: 1 } },
    ]) {
      const res = await call(client, "cron_create", {
        schedule: "* * * * *",
        action: { kind: "agent", adapter: "claude-code", prompt: "x", ...bad },
      })
      expect(res.isError, JSON.stringify(bad)).toBe(true)
    }
    expect(scheduler.list()).toHaveLength(0)
  })

  it("cron_run fires the job through agent_start with profileRef/role threaded through", async () => {
    const dispatchTool = vi.fn<DispatchTool>(async () => okResult({ id: "sess_spawned" }))
    const { scheduler } = makeScheduler({ dispatchTool })
    const client = await buildClient(scheduler)
    const created = await call(client, "cron_create", {
      schedule: "10 22 * * *",
      recurring: false,
      action: { ...supervisorAction, cwd: "/repo" },
    })
    const { jobId } = JSON.parse(created.text) as { jobId: string }

    const ran = await call(client, "cron_run", { jobId })
    expect(ran.isError).toBe(false)
    expect(JSON.parse(ran.text).result).toEqual({
      ok: true,
      summary: "spawned session sess_spawned (adapter=claude-code)",
    })

    expect(dispatchTool).toHaveBeenCalledTimes(1)
    const [tool, inputs] = dispatchTool.mock.calls[0]!
    expect(tool).toBe("agent_start")
    const { kind: _kind, ...fields } = supervisorAction
    expect(inputs).toEqual({ ...fields, cwd: "/repo", origin: `cron:${jobId}` })
  })

  it("any agent_start field round-trips to the agent_start handler with no cron-specific code", async () => {
    // A real `agent_start`-registered server stands in for the daemon's
    // internal one: `dispatchTool` reaches its handler exactly like index.ts
    // does. None of these fields is named anywhere in the cron code.
    const received: Array<Record<string, unknown>> = []
    const internal = new McpServer({ name: "internal", version: "0.0.0" })
    internal.registerTool("agent_start", { inputSchema: agentStartInputShape }, async input => {
      received.push(input as Record<string, unknown>)
      return okResult({ id: "sess_rt" }) as { content: Array<{ type: "text"; text: string }> }
    })
    const registered = (internal as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => unknown }>
    })._registeredTools
    const dispatchTool: DispatchTool = async (name, inputs) => registered[name]!.handler(inputs, {})

    const { scheduler } = makeScheduler({ dispatchTool })
    const client = await buildClient(scheduler)
    const created = await call(client, "cron_create", {
      schedule: "0 0 1 1 *",
      action: {
        kind: "agent",
        adapter: "claude-code",
        prompt: "x",
        idempotencyKey: "nightly-2026-09-26",
        notifyParentOnCrash: "true", // stringified MCP bool, coerced by the shared schema
        maxCostUsd: 5,
        promptAppend: "be brief",
        wait: true, // omitted for a detached fire
      },
    })
    expect(created.isError).toBe(false)
    const { jobId } = JSON.parse(created.text) as { jobId: string }
    expect(scheduler.get(jobId)?.action).not.toHaveProperty("wait")

    await scheduler.run(jobId)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      idempotencyKey: "nightly-2026-09-26",
      notifyParentOnCrash: true,
      maxCostUsd: 5,
      promptAppend: "be brief",
      origin: `cron:${jobId}`,
    })
    expect(received[0]).not.toHaveProperty("wait")
  })

  it("a hand-edited persisted agent job with an invalid field fails at fire time, never dispatched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-parity-bad-agent-"))
    tmpDirs.push(dir)
    const persistPath = join(dir, "cron-jobs.json")
    writeFileSync(
      persistPath,
      JSON.stringify([
        {
          id: "cron_bad",
          schedule: "0 0 1 1 *",
          recurring: true,
          active: true,
          createdAt: new Date().toISOString(),
          action: { kind: "agent", adapter: "claude-code", prompt: "x", access: { profileRef: "" } },
        },
      ]),
    )
    const dispatchTool = vi.fn<DispatchTool>(async () => okResult({ id: "x" }))
    const { scheduler } = makeScheduler({ dispatchTool, persistPath })
    const result = await scheduler.run("cron_bad")
    expect(result?.ok).toBe(false)
    expect(result?.summary).toMatch(/invalid agent_start fields: access.profileRef/)
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it("surfaces an agent_start failure as the job's failed result", async () => {
    const dispatchTool = vi.fn<DispatchTool>(async () => ({
      content: [{ type: "text", text: "auth profile \"gone\" not found" }],
      isError: true,
    }))
    const { scheduler } = makeScheduler({ dispatchTool })
    const job = scheduler.create({
      schedule: "* * * * *",
      action: { kind: "agent", adapter: "claude-code", prompt: "x", access: { profileRef: "gone" } },
    })
    const result = await scheduler.run(job.id)
    expect(result?.ok).toBe(false)
    expect(result?.summary).toMatch(/agent_start failed: auth profile "gone" not found/)
  })

  it("a persisted legacy agent job (pre-existing fields only) loads unchanged and fires via agent_start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cron-parity-legacy-"))
    tmpDirs.push(dir)
    const persistPath = join(dir, "cron-jobs.json")
    const legacy = {
      id: "cron_legacy",
      schedule: "0 9 * * 1-5",
      recurring: true,
      active: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      action: {
        kind: "agent",
        adapter: "claude-code",
        prompt: "morning",
        cwd: "/repo",
        model: "m",
        mode: "plan",
        permissionHold: true,
        options: { skills: "docs" },
      },
    }
    writeFileSync(persistPath, JSON.stringify([legacy]))
    const dispatchTool = vi.fn<DispatchTool>(async () => okResult({ id: "sess_legacy" }))
    const { scheduler } = makeScheduler({ dispatchTool, persistPath })
    expect(scheduler.get("cron_legacy")).toEqual(legacy)

    const result = await scheduler.run("cron_legacy")
    expect(result?.ok).toBe(true)
    const { kind: _kind, ...fields } = legacy.action
    expect(dispatchTool).toHaveBeenCalledWith("agent_start", { ...fields, origin: "cron:cron_legacy" })
  })
})
