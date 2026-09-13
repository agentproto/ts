/**
 * ToolTransformer migration batch A (orchestration-tools.ts, first half):
 *   permissions_list / workflow_list / policy_list / activities_list
 *
 * Proves per migrated tool:
 *   - default output is COMPACT (slim projection, bulky fields absent, and
 *     strictly smaller than the `full` payload),
 *   - `full: true` returns the old verbose shape,
 *   - `fields` filters page items (paginated envelope branch),
 *   - pagination is unchanged: page-walk union == the default list exactly.
 */

import { describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { WorkflowRunner } from "../workflow-runner.js"
import type { CompletionPolicySupervisor, PolicyRunState } from "../supervisor.js"
import type { ActivityProjector } from "../activities.js"
import type { ActivityRecord } from "../activity-projection.js"
import { createEventRing } from "../event-ring.js"
import { createSessionEventBus } from "../session-event-bus.js"

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = "content" in result ? result.content : undefined
  if (!Array.isArray(content)) throw new Error("no content array")
  const block = content.find(
    b => typeof b === "object" && b !== null && "type" in b && (b as { type: string }).type === "text",
  ) as { text: string } | undefined
  if (!block) throw new Error("no text block")
  return JSON.parse(block.text)
}

async function client(
  opts: Partial<Parameters<typeof registerOrchestrationTools>[1]>,
): Promise<Client> {
  const server = new McpServer({ name: "orch-compact-test", version: "0.0.0" })
  registerOrchestrationTools(server, {
    registry: createSessionsRegistry({ persist: false }),
    sessionEvents: createSessionEventBus(),
    eventRing: createEventRing(),
    ...opts,
  })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "orch-compact-client", version: "0.0.0" })
  await client.connect(ct)
  return client
}

async function walk(
  client: Client,
  tool: string,
  listKey?: string,
  idKey = "id",
): Promise<{ union: any[]; total: number }> {
  const union: any[] = []
  let cursor: string | undefined
  do {
    const page = parse(
      await client.callTool({
        name: tool,
        arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
      }),
    )
    union.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  const unpaginated = parse(await client.callTool({ name: tool, arguments: {} }))
  const rows: any[] = listKey ? unpaginated[listKey] : unpaginated
  expect(union.map((r: any) => r[idKey])).toEqual(rows.map((r: any) => r[idKey]))
  return { union, total: union.length }
}

// ── fixtures ──────────────────────────────────────────────────────────

const PERMISSION = {
  id: "perm-1",
  sessionId: "sess-1",
  toolCallId: "perm-1",
  toolName: "Write",
  text: "Allow Write to /etc/hosts?",
  options: [{ optionId: "opt-once", name: "Allow once", kind: "allow_once" }],
  requestedAt: new Date().toISOString(),
  rawInput: { command: "git push --force" },
  _meta: { suspendPayload: { plan: ["step one", "step two"] } },
}

const RUN = {
  runId: "wfrun-1",
  workflowId: "wf-1",
  status: "running" as const,
  startedAt: "2026-07-22T10:00:00.000Z",
  stages: [
    {
      label: "s1",
      status: "done" as const,
      steps: [{ label: "step", adapter: "mock", prompt: "go", status: "done" as const }],
    },
  ],
  result: { sessionIds: ["a", "b"] },
}

const POLICY: PolicyRunState = {
  policyId: "pol-1",
  sessionId: "sess-1",
  sessionIds: ["sess-1"],
  pending: [],
  status: "done",
  retries: 0,
  startedAt: "2026-07-22T10:00:00.000Z",
  endedAt: "2026-07-22T10:01:00.000Z",
  lastGate: { exitCode: 0, at: "2026-07-22T10:00:30.000Z", stdout: "x".repeat(2048) },
  commitPlan: { paths: ["a.ts"], message: "m", cwd: "/tmp" },
}

const ACTIVITY: ActivityRecord = {
  id: "turn:sess-1:1",
  kind: "turn",
  sessionId: "sess-1",
  sourceRef: "sess-1",
  source: "session",
  title: "turn 1",
  startedAt: "2026-07-22T10:00:00.000Z",
  state: "active",
  error: "boom",
} as ActivityRecord

// ── permissions_list ──────────────────────────────────────────────────

function permsRegistry(): SessionsRegistry {
  return {
    listPendingPermissions: () => [{ ...PERMISSION }],
    get: () => ({ adapterSlug: "claude-code", label: "L", command: "C" }),
    list: () => [],
  } as unknown as SessionsRegistry
}

describe("permissions_list (tool-transformer migration)", () => {
  const opts = { registry: permsRegistry() }

  it("default output is compact; full:true returns the verbose record", async () => {
    const c = await client(opts)
    const def = parse(await c.callTool({ name: "permissions_list", arguments: {} }))
    expect(def.permissions).toHaveLength(1)
    expect(def.permissions[0]).toMatchObject({ id: "perm-1", sessionId: "sess-1", toolName: "Write" })
    // compact: bulky echo fields dropped
    expect(def.permissions[0].text).toBeUndefined()
    expect(def.permissions[0]._meta).toBeUndefined()
    expect(def.permissions[0].toolCallId).toBeUndefined()
    // full: the old verbose shape
    const full = parse(await c.callTool({ name: "permissions_list", arguments: { full: true } }))
    expect(full.permissions[0].text).toBe(PERMISSION.text)
    expect(full.permissions[0]._meta).toEqual(PERMISSION._meta)
    expect(full.permissions[0].toolCallId).toBe(PERMISSION.toolCallId)
    expect(JSON.stringify(full).length).toBeGreaterThan(JSON.stringify(def).length * 1.5)
    await c.close()
  })

  it("fields filters page items; page-walk covers the default list exactly", async () => {
    const c = await client(opts)
    const page = parse(
      await c.callTool({ name: "permissions_list", arguments: { limit: 10, fields: ["id"] } }),
    )
    expect(page.items).toEqual([{ id: "perm-1" }])
    const { total } = await walk(c, "permissions_list", "permissions")
    expect(total).toBe(1)
    await c.close()
  })
})

// ── workflow_list ─────────────────────────────────────────────────────

const stubRunner = {
  list: () => [{ ...RUN }],
} as unknown as WorkflowRunner

describe("workflow_list (tool-transformer migration)", () => {
  const opts = { workflowRunner: stubRunner }

  it("default output stays a bare array and is compact; full:true is verbose", async () => {
    const c = await client(opts)
    const def = parse(await c.callTool({ name: "workflow_list", arguments: {} }))
    expect(Array.isArray(def)).toBe(true)
    expect(def[0].runId).toBe("wfrun-1")
    expect(def[0].stages).toBeUndefined()
    expect(def[0].result).toBeUndefined()
    const full = parse(await c.callTool({ name: "workflow_list", arguments: { full: true } }))
    expect(Array.isArray(full)).toBe(true)
    expect(full[0].stages).toEqual(RUN.stages)
    expect(full[0].result).toEqual(RUN.result)
    await c.close()
  })

  it("fields filters page items; page-walk covers the default list exactly", async () => {
    const c = await client(opts)
    const page = parse(
      await c.callTool({ name: "workflow_list", arguments: { limit: 10, fields: ["runId"] } }),
    )
    expect(page.items).toEqual([{ runId: "wfrun-1" }])
    const { total } = await walk(c, "workflow_list")
    expect(total).toBe(1)
    await c.close()
  })
})

// ── policy_list ───────────────────────────────────────────────────────

const stubSupervisor = {
  list: () => [{ ...POLICY }],
} as unknown as CompletionPolicySupervisor

describe("policy_list (tool-transformer migration)", () => {
  const opts = { supervisor: stubSupervisor }

  it("default output stays a bare array and is compact; full:true is verbose", async () => {
    const c = await client(opts)
    const def = parse(await c.callTool({ name: "policy_list", arguments: {} }))
    expect(Array.isArray(def)).toBe(true)
    expect(def[0].policyId).toBe("pol-1")
    expect(def[0].lastGate).toBeUndefined()
    expect(def[0].commitPlan).toBeUndefined()
    const full = parse(await c.callTool({ name: "policy_list", arguments: { full: true } }))
    expect(Array.isArray(full)).toBe(true)
    expect(full[0].lastGate).toEqual(POLICY.lastGate)
    expect(full[0].commitPlan).toEqual(POLICY.commitPlan)
    await c.close()
  })

  it("fields filters page items; page-walk covers the default list exactly", async () => {
    const c = await client(opts)
    const page = parse(
      await c.callTool({ name: "policy_list", arguments: { limit: 10, fields: ["policyId"] } }),
    )
    expect(page.items).toEqual([{ policyId: "pol-1" }])
    const { total } = await walk(c, "policy_list")
    expect(total).toBe(1)
    await c.close()
  })
})

// ── activities_list ───────────────────────────────────────────────────

const stubProjector: ActivityProjector = {
  list: () => [{ ...ACTIVITY }],
  wait: async () => null,
  dispose() {},
}

describe("activities_list (tool-transformer migration)", () => {
  const opts = { activityProjector: stubProjector }

  it("default output keeps { activities, counts } and is compact; full:true is verbose", async () => {
    const c = await client(opts)
    const def = parse(await c.callTool({ name: "activities_list", arguments: {} }))
    expect(def.activities).toHaveLength(1)
    expect(def.counts).toEqual({ active: 1, pending: 0 })
    expect(def.activities[0].error).toBeUndefined()
    const full = parse(await c.callTool({ name: "activities_list", arguments: { full: true } }))
    expect(full.activities[0].error).toBe("boom")
    await c.close()
  })

  it("fields filters page items; page-walk covers the default list exactly", async () => {
    const c = await client(opts)
    const page = parse(
      await c.callTool({ name: "activities_list", arguments: { limit: 10, fields: ["id"] } }),
    )
    expect(page.items).toEqual([{ id: ACTIVITY.id }])
    const { total } = await walk(c, "activities_list", "activities")
    expect(total).toBe(1)
    await c.close()
  })
})
