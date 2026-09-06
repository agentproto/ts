/**
 * Tests for the app-scoped state ledger (app-state.ts) and its tool
 * registrations in app-data.ts. Mirrors app-data.test.ts's real-McpServer +
 * InMemoryTransport pattern — no heavy mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  AppAppStateError,
  appStateEventsPath,
  appStateLedgerExists,
  appStateSnapshot,
  appendAppStateEvent,
  foldAppStateEvents,
  readAppStateEvents,
  ulid,
} from "../app-state.js"
import { registerAppDataTools } from "../app-data.js"
import { withToolExclusion } from "../tool-subset.js"
import { createAppRegistry } from "../app-registry.js"
import type { AppStateEvent, AppStateEventInput } from "../app-state.js"

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string; isError?: boolean }> })
    .content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}
function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

const APP_ID = "@test/state-app"

async function setup(dir: string, opts?: { deny?: ReadonlySet<string> }) {
  const appRegistry = createAppRegistry()
  appRegistry.upsertApp({
    appId: APP_ID,
    dir,
    agents: [],
    workflows: [],
    unvalidatedAgentTools: [],
  })
  let server: McpServer = new McpServer({ name: "app-state-test-server", version: "0.0.0" })
  const target = opts?.deny ? withToolExclusion(server, opts.deny) : server
  registerAppDataTools(target, { appRegistry })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "app-state-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, app: { dir, dataDir: join(dir, "data") } }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "app-state-test-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const stageStarted = (stage: string, extra: Partial<AppStateEventInput> = {}): AppStateEventInput => ({
  stage,
  kind: "stage-started",
  by: "runner",
  payload: {},
  ...extra,
})

describe("ulid", () => {
  it("produces 26-char Crockford ids, unique across a burst", () => {
    const ids = new Set(Array.from({ length: 500 }, () => ulid()))
    expect(ids.size).toBe(500)
    for (const id of ids) expect(id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/)
  })
})

describe("appendAppStateEvent", () => {
  it("appends one JSONL line and daemon-assigns id/ts", async () => {
    const app = { dir, dataDir: join(dir, "data") }
    const stored = await appendAppStateEvent(app, stageStarted("draft"))
    expect(stored).toMatchObject({ stage: "draft", kind: "stage-started", by: "runner" })
    expect(stored.id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/)
    expect(new Date(stored.ts).toString()).not.toBe("Invalid Date")

    const raw = await readFile(appStateEventsPath(app), "utf8")
    const lines = raw.split("\n").filter(l => l.trim() !== "")
    expect(lines).toHaveLength(1)
    expect((JSON.parse(lines[0]!) as { id: string }).id).toBe(stored.id)
  })

  it("rejects invalid payloads per kind", async () => {
    const app = { dir, dataDir: join(dir, "data") }
    await expect(
      appendAppStateEvent(app, { stage: "s", kind: "gate-report", by: "runner", payload: { ok: true } }),
    ).rejects.toBeInstanceOf(AppAppStateError) // missing exitCode
    await expect(
      appendAppStateEvent(app, { stage: "s", kind: "gate-report", by: "runner", payload: { exitCode: 1 } }),
    ).rejects.toBeInstanceOf(AppAppStateError) // missing ok
    await expect(
      appendAppStateEvent(app, { stage: "s", kind: "approval", by: "human", payload: { approved: true } }),
    ).rejects.toBeInstanceOf(AppAppStateError) // missing who
    await expect(
      appendAppStateEvent(app, { stage: "s", kind: "blocked", by: "policy", payload: {} }),
    ).rejects.toBeInstanceOf(AppAppStateError) // missing reason
    await expect(
      appendAppStateEvent(app, { stage: "s", kind: "nope" as never, by: "runner", payload: {} }),
    ).rejects.toBeInstanceOf(AppAppStateError) // unknown kind
    await expect(
      appendAppStateEvent(app, { stage: "s", kind: "note", by: "admin" as never, payload: {} }),
    ).rejects.toBeInstanceOf(AppAppStateError) // unknown by
    // Nothing was written.
    expect(await appStateLedgerExists(app)).toBe(false)
  })

  it("keeps two interleaved appends as two intact lines", async () => {
    const app = { dir, dataDir: join(dir, "data") }
    const [a, b] = await Promise.all([
      appendAppStateEvent(app, stageStarted("one")),
      appendAppStateEvent(app, stageStarted("two")),
    ])
    expect(a.id).not.toBe(b.id)
    const { events } = await readAppStateEvents(app)
    expect(events).toHaveLength(2)
    expect(new Set(events.map(e => e.id))).toEqual(new Set([a.id, b.id]))
  })
})

describe("foldAppStateEvents", () => {
  const stamp = (list: AppStateEventInput[]): AppStateEvent[] =>
    list.map((e, i) => ({ ...e, id: ulid(), ts: new Date(Date.UTC(2026, 8, 5, 0, 0, i)).toISOString() }))

  it("walks pending → running → gated-failed → blocked → done → approved", () => {
    const events = stamp([
      stageStarted("publish"),
      { stage: "publish", kind: "gate-report", by: "runner", payload: { ok: false, exitCode: 2 } },
      { stage: "publish", kind: "blocked", by: "policy", payload: { reason: "failing gate" } },
      { stage: "publish", kind: "stage-done", by: "runner", payload: {} },
      { stage: "publish", kind: "approval", by: "human", payload: { approved: true, who: "jeremy" } },
    ])
    const statuses = events.map((_, i) => foldAppStateEvents(events.slice(0, i + 1)).stages.publish!.status)
    expect(statuses).toEqual(["running", "gated-failed", "blocked", "done", "approved"])
    const final = foldAppStateEvents(events).stages.publish!
    expect(final.status).toBe("approved")
    expect(final.lastGate).toMatchObject({ ok: false, exitCode: 2 })
  })

  it("re-opens a blocked stage on a later stage-done", () => {
    const events = stamp([
      { stage: "s", kind: "blocked", by: "policy", payload: { reason: "x" } },
      { stage: "s", kind: "stage-done", by: "runner", payload: {} },
    ])
    expect(foldAppStateEvents(events).stages.s!.status).toBe("done")
  })

  it("item events drive items, not the stage status; notes change nothing", () => {
    const events = stamp([
      stageStarted("s"),
      { stage: "s", item: "ch1", kind: "stage-started", by: "runner", payload: {} },
      { stage: "s", item: "ch1", kind: "stage-done", by: "runner", payload: {} },
      { stage: "s", kind: "note", by: "system", payload: { text: "hello" } },
    ])
    const snap = foldAppStateEvents(events)
    expect(snap.stages.s!.status).toBe("running")
    expect(snap.stages.s!.items?.ch1).toMatchObject({ status: "done" })
    expect(snap.stages.s!.lastEvent?.kind).toBe("note")
  })
})

describe("readAppStateEvents tolerance", () => {
  it("skips malformed lines and counts them", async () => {
    const app = { dir, dataDir: join(dir, "data") }
    await appendAppStateEvent(app, stageStarted("s"))
    const path = appStateEventsPath(app)
    const raw = await readFile(path, "utf8")
    await import("node:fs/promises").then(fs => fs.appendFile(path, "{broken json\n"))
    const { events, malformedLines } = await readAppStateEvents(app)
    expect(events).toHaveLength(1)
    expect(malformedLines).toBe(1)
    expect(raw).toContain("stage-started")
  })
})

describe("app_state_* tools", () => {
  it("append/get/list round-trip with filters", async () => {
    const { client, app } = await setup(dir)
    await client.callTool({
      name: "app_state_append",
      arguments: { appId: APP_ID, event: stageStarted("a", { appRunId: "run1" }) },
    })
    await client.callTool({
      name: "app_state_append",
      arguments: {
        appId: APP_ID,
        event: { stage: "a", kind: "stage-done", by: "runner", payload: {} },
      },
    })
    await client.callTool({
      name: "app_state_append",
      arguments: {
        appId: APP_ID,
        event: { stage: "b", kind: "note", by: "system", payload: { text: "x" } },
      },
    })

    const got = parseToolJson(await client.callTool({ name: "app_state_get", arguments: { appId: APP_ID } }))
    expect(got.snapshot.stages.a.status).toBe("done")
    expect(got.snapshot.stages.b.status).toBe("pending")
    expect(got.events).toHaveLength(3)

    const byStage = parseToolJson(
      await client.callTool({
        name: "app_state_list",
        arguments: { appId: APP_ID, stage: "a", kinds: ["stage-started"] },
      }),
    )
    expect(byStage.events).toHaveLength(1)
    expect(byStage.events[0]).toMatchObject({ stage: "a", kind: "stage-started", appRunId: "run1" })

    const limited = parseToolJson(
      await client.callTool({ name: "app_state_list", arguments: { appId: APP_ID, limit: 2 } }),
    )
    expect(limited.events).toHaveLength(2)
    expect(limited.total).toBe(3)

    // Fold + projection primitives agree with the tool view.
    const snap = await appStateSnapshot(app)
    expect(snap.stages.a!.status).toBe("done")
  })

  it("rejects an invalid event envelope and an unknown appId (path safety)", async () => {
    const { client } = await setup(dir)
    const badPayload = await client
      .callTool({
        name: "app_state_append",
        arguments: {
          appId: APP_ID,
          event: { stage: "s", kind: "gate-report", by: "runner", payload: { ok: "yes" } },
        },
      })
      .catch(() => null)
    expect(badPayload === null || isError(badPayload)).toBe(true)

    const traversal = await client.callTool({
      name: "app_state_append",
      arguments: { appId: "@test/../../escape", event: stageStarted("s") },
    })
    expect(isError(traversal)).toBe(true)
    const msg = parseToolJson(traversal).error as string
    expect(msg).toContain("no installed app")
  })

  it("agent-role caller (deny set) never gets app_state_append; reads stay open; plain caller (runner/UI) keeps it", async () => {
    // The daemon strips app_state_append from agent sessions via
    // withToolExclusion at the /mcp factory (index.ts) — the same plumbing
    // as the role denyTools gate. Mirror it here.
    const denied = await setup(dir, { deny: new Set(["app_state_append"]) })
    const deniedList = await denied.client.listTools()
    const deniedNames = deniedNamesOf(deniedList)
    expect(deniedNames).not.toContain("app_state_append")
    expect(deniedNames).toContain("app_state_get")
    expect(deniedNames).toContain("app_state_list")
    const callDenied = await denied.client
      .callTool({
        name: "app_state_append",
        arguments: { appId: APP_ID, event: stageStarted("s") },
      })
      .catch(() => null)
    expect(callDenied === null || isError(callDenied)).toBe(true)

    // The runner / UI path registers and can append.
    const allowed = await setup(dir)
    const names = allowedNamesOf(await allowed.client.listTools())
    expect(names).toContain("app_state_append")
    const ok = parseToolJson(
      await allowed.client.callTool({
        name: "app_state_append",
        arguments: { appId: APP_ID, event: stageStarted("s") },
      }),
    )
    expect(ok.event).toMatchObject({ kind: "stage-started" })
  })
})

function deniedNamesOf(res: unknown): string[] {
  return ((res as { tools?: { name: string }[] }).tools ?? []).map(t => t.name)
}
function allowedNamesOf(res: unknown): string[] {
  return deniedNamesOf(res)
}