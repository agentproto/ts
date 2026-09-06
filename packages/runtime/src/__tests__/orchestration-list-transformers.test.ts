/**
 * Batch-B migration of the last four `pageParamsShape` consumers in
 * `orchestration-tools.ts` onto the `ToolTransformer` mechanism
 * (`defineTool` + `implementTool` + `toMcpTool` + `paginated()` +
 * `catchErrors()`):
 *
 *   - inbound_watcher_list
 *   - inbound_endpoint_list
 *   - cron_list
 *   - routine_list
 *
 * Proves per tool:
 *   1. default output is the COMPACT projection (small, per-tool field set);
 *   2. `full: true` / `compact: false` returns the old verbose shape;
 *   3. `fields` is a per-item allowlist on the paginated envelope branch;
 *   4. pagination (`limit`/`cursor`/`total`/`nextCursor`) semantics are
 *      unchanged — a page-walk covers exactly the full list.
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import type { WatcherDescriptor } from "../inbound-watcher.js"
import type { InboundEndpoint } from "../inbound-endpoints.js"
import type { CronJob } from "../cron-scheduler.js"
import type { RoutineFrontmatter } from "@agentproto/routine"

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any).content[0]?.text ?? "{}"
}

async function buildClient(
  opts: Parameters<typeof registerOrchestrationTools>[1],
): Promise<Client> {
  const server = new McpServer({ name: "batch-b-test", version: "0.0.0" })
  registerOrchestrationTools(server, opts)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "batch-b-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

function baseOpts(): Parameters<typeof registerOrchestrationTools>[1] {
  const sessionEvents = createSessionEventBus()
  const eventRing = createEventRing()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  return { registry, sessionEvents, eventRing }
}

async function walk(
  client: Client,
  tool: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const union: Array<Record<string, unknown>> = []
  let cursor: string | undefined
  do {
    const result = await client.callTool({
      name: tool,
      arguments: { limit, ...(cursor ? { cursor } : {}) },
    })
    const page = JSON.parse(textOf(result)) as {
      items: Array<Record<string, unknown>>
      nextCursor?: string
      total?: number
    }
    expect(page.total, "total present on every page").toBeGreaterThan(0)
    union.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return union
}

// ── fakes ────────────────────────────────────────────────────────────

function fakeWatcher(): {
  inboundWatcher: Parameters<typeof registerOrchestrationTools>[1]["inboundWatcher"]
  watchers: WatcherDescriptor[]
} {
  const watchers: WatcherDescriptor[] = Array.from({ length: 5 }, (_, i) => ({
    watcherId: `w${i}`,
    alias: "agentpush",
    source: "src",
    adapter: "claude-code",
    pollIntervalMs: 5000,
    status: i % 2 === 0 ? "running" : "stopped",
    cursor: 100 + i,
    lastPollAt: "2026-01-01T00:00:00Z",
    lastFireAt: "2026-01-01T00:01:00Z",
    spawned: i,
  }))
  return {
    watchers,
    inboundWatcher: {
      start: () => watchers[0]!,
      stop: () => true,
      list: () => watchers,
      shutdown: () => {},
    },
  }
}

function fakeEndpointStore(endpoints: InboundEndpoint[]) {
  return {
    get: (slug: string) => endpoints.find(e => e.slug === slug),
    upsert: (e: InboundEndpoint) => e as InboundEndpoint,
    remove: () => true,
    list: () => endpoints,
    markSeen: () => true,
    flushSync: () => {},
  }
}

function fakeCron(jobs: CronJob[]) {
  return {
    create: () => jobs[0]!,
    list: () => jobs,
    get: (id: string) => jobs.find(j => j.id === id),
    delete: () => {},
    run: async () => ({ ok: true, summary: "stub" }),
    shutdown: () => {},
  }
}

function fakeRoutineRegistrar(routines: RoutineFrontmatter[]) {
  return {
    reconcile: () => ({ registered: [], skipped: [], removed: [], errors: [] }),
    trigger: async () => ({ ok: true, summary: "stub" }),
    list: () => routines,
  }
}

function fakeEndpoint(i: number): InboundEndpoint {
  return {
    slug: `ep${i}`,
    provider: "agentpush",
    alias: "default",
    source: `src${i}`,
    secret: `super-secret-${i}`,
    mode: "route-or-spawn",
    enabled: true,
    createdTs: 1000 + i,
    lastSeenTs: 2000 + i,
  }
}

function fakeCronJob(i: number): CronJob {
  return {
    id: `job${i}`,
    label: `Job ${i}`,
    schedule: "0 9 * * 1-5",
    recurring: true,
    action: { kind: "command", command: "echo" },
    createdAt: "2026-01-01T00:00:00Z",
    active: i % 2 === 0,
    nextRunAt: "2026-01-02T09:00:00Z",
    lastRunAt: "2026-01-01T09:00:00Z",
    lastResult: { ok: true, summary: "ran" },
  }
}

function fakeRoutine(i: number): RoutineFrontmatter {
  return {
    schema: "routine/v1",
    id: `r${i}`,
    description: `Routine ${i}`,
    version: "1.0.0",
    schedule: { kind: "cron", cron: "0 4 * * *" },
    target: { tool: "worktree_gc", inputs: { apply: true } },
    fires_events: ["routine-triggered", "routine-completed", "routine-failed"],
    enabled: i % 2 === 0,
    tags: ["test"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

// ── inbound_watcher_list ─────────────────────────────────────────────

describe("inbound_watcher_list transformer migration", () => {
  it("default output is compact; full:true returns the verbose descriptor", async () => {
    const { inboundWatcher, watchers } = fakeWatcher()
    const client = await buildClient({ ...baseOpts(), inboundWatcher })

    const compact = JSON.parse(
      textOf(await client.callTool({ name: "inbound_watcher_list", arguments: {} })),
    ) as { watchers: Array<Record<string, unknown>> }
    expect(compact.watchers).toHaveLength(5)
    for (const w of compact.watchers) {
      expect(Object.keys(w).sort()).toEqual([
        "adapter",
        "alias",
        "source",
        "spawned",
        "status",
        "watcherId",
      ])
    }

    const full = JSON.parse(
      textOf(
        await client.callTool({
          name: "inbound_watcher_list",
          arguments: { full: true },
        }),
      ),
    ) as { watchers: WatcherDescriptor[] }
    expect(full.watchers).toEqual(watchers)
    expect(full.watchers[0]).toHaveProperty("pollIntervalMs")
    expect(full.watchers[0]).toHaveProperty("lastPollAt")
    expect(full.watchers[0]).toHaveProperty("lastFireAt")
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length)
    await client.close()
  })

  it("fields filters per item on the paginated branch; page-walk covers the list", async () => {
    const { inboundWatcher } = fakeWatcher()
    const client = await buildClient({ ...baseOpts(), inboundWatcher })

    const fields = JSON.parse(
      textOf(
        await client.callTool({
          name: "inbound_watcher_list",
          arguments: { limit: 2, fields: ["watcherId"] },
        }),
      ),
    ) as { items: Array<Record<string, unknown>>; total: number; nextCursor?: string }
    expect(fields.total).toBe(5)
    expect(fields.nextCursor).toBeTruthy()
    expect(fields.items).toEqual([
      { watcherId: "w0" },
      { watcherId: "w1" },
    ])

    const walked = await walk(client, "inbound_watcher_list", 2)
    expect(walked.map(w => w.watcherId)).toEqual([
      "w0",
      "w1",
      "w2",
      "w3",
      "w4",
    ])
    await client.close()
  })
})

// ── inbound_endpoint_list ────────────────────────────────────────────

describe("inbound_endpoint_list transformer migration", () => {
  const endpoints = [0, 1, 2, 3].map(fakeEndpoint)

  it("default output is compact; full:true returns the sanitized (no-secret) record", async () => {
    const client = await buildClient({
      ...baseOpts(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      endpointStore: fakeEndpointStore(endpoints) as any,
    })

    const compact = JSON.parse(
      textOf(await client.callTool({ name: "inbound_endpoint_list", arguments: {} })),
    ) as { endpoints: Array<Record<string, unknown>> }
    expect(compact.endpoints).toHaveLength(4)
    for (const e of compact.endpoints) {
      expect(Object.keys(e).sort()).toEqual([
        "alias",
        "enabled",
        "mode",
        "provider",
        "slug",
      ])
    }

    const full = JSON.parse(
      textOf(
        await client.callTool({
          name: "inbound_endpoint_list",
          arguments: { full: true },
        }),
      ),
    ) as { endpoints: Array<Record<string, unknown>> }
    expect(full.endpoints[0]).toHaveProperty("createdTs")
    expect(full.endpoints[0]).toHaveProperty("lastSeenTs")
    expect(full.endpoints[0]).toHaveProperty("has_secret", true)
    expect(JSON.stringify(full)).not.toContain("super-secret")
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length)
    await client.close()
  })

  it("fields filters per item on the paginated branch; page-walk covers the list", async () => {
    const client = await buildClient({
      ...baseOpts(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      endpointStore: fakeEndpointStore(endpoints) as any,
    })

    const fields = JSON.parse(
      textOf(
        await client.callTool({
          name: "inbound_endpoint_list",
          arguments: { limit: 3, fields: ["slug"] },
        }),
      ),
    ) as { items: Array<Record<string, unknown>>; total: number }
    expect(fields.total).toBe(4)
    expect(fields.items).toEqual([
      { slug: "ep0" },
      { slug: "ep1" },
      { slug: "ep2" },
    ])

    const walked = await walk(client, "inbound_endpoint_list", 3)
    expect(walked.map(e => e.slug)).toEqual(["ep0", "ep1", "ep2", "ep3"])
    await client.close()
  })
})

// ── cron_list ────────────────────────────────────────────────────────

describe("cron_list transformer migration", () => {
  const jobs = [0, 1, 2, 3, 4].map(fakeCronJob)

  it("default output is compact; full:true returns the verbose job record", async () => {
    const client = await buildClient({
      ...baseOpts(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cronScheduler: fakeCron(jobs) as any,
    })

    const compact = JSON.parse(
      textOf(await client.callTool({ name: "cron_list", arguments: {} })),
    ) as { jobs: Array<Record<string, unknown>> }
    expect(compact.jobs).toHaveLength(5)
    for (const j of compact.jobs) {
      expect(Object.keys(j).sort()).toEqual([
        "active",
        "id",
        "label",
        "lastRunAt",
        "nextRunAt",
        "recurring",
        "schedule",
      ])
    }

    const full = JSON.parse(
      textOf(
        await client.callTool({ name: "cron_list", arguments: { full: true } }),
      ),
    ) as { jobs: CronJob[] }
    expect(full.jobs).toEqual(jobs)
    expect(full.jobs[0]).toHaveProperty("action")
    expect(full.jobs[0]).toHaveProperty("createdAt")
    expect(full.jobs[0]).toHaveProperty("lastResult")
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length)
    await client.close()
  })

  it("fields filters per item on the paginated branch; page-walk covers the list", async () => {
    const client = await buildClient({
      ...baseOpts(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cronScheduler: fakeCron(jobs) as any,
    })

    const fields = JSON.parse(
      textOf(
        await client.callTool({
          name: "cron_list",
          arguments: { limit: 2, fields: ["id", "active"] },
        }),
      ),
    ) as { items: Array<Record<string, unknown>>; total: number }
    expect(fields.total).toBe(5)
    expect(fields.items).toEqual([
      { id: "job0", active: true },
      { id: "job1", active: false },
    ])

    const walked = await walk(client, "cron_list", 2)
    expect(walked.map(j => j.id)).toEqual([
      "job0",
      "job1",
      "job2",
      "job3",
      "job4",
    ])
    await client.close()
  })
})

// ── routine_list ─────────────────────────────────────────────────────

describe("routine_list transformer migration", () => {
  const routines = [0, 1, 2].map(fakeRoutine)

  it("default output is compact; full:true returns the verbose frontmatter", async () => {
    const client = await buildClient({
      ...baseOpts(),
      routineRegistrar: fakeRoutineRegistrar(routines),
    })

    const compact = JSON.parse(
      textOf(await client.callTool({ name: "routine_list", arguments: {} })),
    ) as { routines: Array<Record<string, unknown>> }
    expect(compact.routines).toHaveLength(3)
    for (const r of compact.routines) {
      expect(Object.keys(r).sort()).toEqual([
        "description",
        "enabled",
        "id",
        "schedule",
        "tags",
        "version",
      ])
    }

    const full = JSON.parse(
      textOf(
        await client.callTool({
          name: "routine_list",
          arguments: { full: true },
        }),
      ),
    ) as { routines: RoutineFrontmatter[] }
    expect(full.routines).toEqual(routines)
    expect(full.routines[0]).toHaveProperty("target")
    expect(full.routines[0]).toHaveProperty("fires_events")
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length)
    await client.close()
  })

  it("fields filters per item on the paginated branch; page-walk covers the list", async () => {
    const client = await buildClient({
      ...baseOpts(),
      routineRegistrar: fakeRoutineRegistrar(routines),
    })

    const fields = JSON.parse(
      textOf(
        await client.callTool({
          name: "routine_list",
          arguments: { limit: 2, fields: ["id"] },
        }),
      ),
    ) as { items: Array<Record<string, unknown>>; total: number }
    expect(fields.total).toBe(3)
    expect(fields.items).toEqual([{ id: "r0" }, { id: "r1" }])

    const walked = await walk(client, "routine_list", 2)
    expect(walked.map(r => r.id)).toEqual(["r0", "r1", "r2"])
    await client.close()
  })
})
