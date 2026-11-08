/**
 * PR2 of docs/design/exposes-tools-contract.md on the real gateway: an app's
 * `exposes.tools` become `<prefix>_<name>` MCP tools right after `app_install`
 * (no restart), with the per-agent opt-in for write/approve, the AGENT deny
 * grants winning, the install-time prefix refusal and the
 * `defaults.apps.exposedTools` kill-switch. Real `createGateway`, isolated HOME.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import matter from "gray-matter"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { defineApp } from "@agentproto/app"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"

import type { GatewayHandle } from "../index.js"
import type { AgentSessionLike } from "../sessions.js"
import { DAEMON_TOOL_NAMES } from "../daemon-tool-names.generated.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

let home = ""
let workspace = ""
let gateway: GatewayHandle

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "exposed-tools-gateway-"))
  vi.stubEnv("HOME", home)
  vi.stubEnv("AGENTPROTO_HOME", join(home, ".agentproto"))
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

beforeEach(async () => {
  workspace = await mkdtemp(join(home, "ws-"))
  await rm(join(homedir(), ".agentproto", "config.json"), { force: true })
  await rm(join(homedir(), ".agentproto", "apps.json"), { force: true })
  const { createGateway } = await import("../index.js")
  gateway = await createGateway({
    workspace,
    specs: [],
    port: await freePort(),
    boot: false,
    persist: false,
    persistPath: join(home, "sessions.json"),
  })
})
afterEach(async () => {
  await gateway.stop()
})

async function writeManifest(dir: string, kind: "tools" | "drivers", id: string, file: string, data: Record<string, unknown>) {
  const target = join(dir, ".agentproto", kind, id, file)
  await mkdir(join(target, ".."), { recursive: true })
  await writeFile(target, matter.stringify("", data), "utf8")
}

/** An installable app exposing `<prefix>_list` (read) and `<prefix>_leads_upsert` (write), each backed by a node driver. */
async function buildApp(opts: { id: string; prefix: string }): Promise<string> {
  const dir = await mkdtemp(join(home, "app-"))
  const listId = `${opts.prefix}.list`
  const upsertId = `${opts.prefix}.leads.upsert`
  await defineApp({
    id: opts.id,
    name: opts.id,
    agents: [
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "worker",
          description: "Worker.",
          model: "claude-sonnet-5",
          workflows: [{ ref: "list-flow" }],
        }),
        body: "Work.",
      },
    ],
    workflows: [
      defineWorkflow({
        id: "list-flow",
        name: "List",
        description: "Lists.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [{ id: "s", kind: "tool", tool: listId }],
      }),
    ],
  }).emit(dir)
  const appMd = join(dir, ".agentproto", "APP.md")
  const exposesYaml = [
    "exposes:",
    `  prefix: ${opts.prefix}`,
    "  tools:",
    `    - { id: ${listId}, access: read, description: "List the leads." }`,
    `    - { id: ${upsertId}, access: write, description: "Create or update a lead." }`,
  ].join("\n")
  await writeFile(appMd, (await readFile(appMd, "utf8")).replace(/^---\n/, `---\n${exposesYaml}\n`), "utf8")

  for (const [id, label] of [
    [listId, "listed"],
    [upsertId, "upserted"],
  ] as const) {
    await writeManifest(dir, "tools", id, "TOOL.md", {
      schema: "agentproto/tool/v1",
      id,
      name: id,
      description: `Tool ${id}.`,
      version: "1.0.0",
      inputs: { type: "object", properties: { q: { type: "string" } } },
      outputs: { type: "object", properties: {} },
      ...(id === upsertId ? { tags: ["mutator"] } : {}),
    })
    await writeManifest(dir, "drivers", `${id}-cli`, "DRIVER.md", {
      schema: "agentproto/driver/v1",
      id: `${id}-cli`,
      name: `${id} driver`,
      description: "node -e driver.",
      version: "1.0.0",
      kind: "cli",
      implements: [
        {
          tool: id,
          version: "*",
          metadata: {
            cli: {
              argv: ["-e", `console.log(JSON.stringify({ ${label}: true, q: process.argv[1] }))`, "${input.q}"],
              outputFormat: "json",
            },
          },
        },
      ],
      metadata: { cli: { bin: process.execPath } },
    })
  }
  return dir
}

async function withClient<T>(callerId: string | undefined, fn: (c: Client) => Promise<T>): Promise<T> {
  const url = new URL(`${gateway.url}/mcp${callerId !== undefined ? `?callerSessionId=${encodeURIComponent(callerId)}` : ""}`)
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(url))
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}

const listTools = (callerId?: string) =>
  withClient(callerId, async c => (await c.listTools()).tools.map(t => t.name))

async function call(callerId: string | undefined, name: string, args: Record<string, unknown> = {}) {
  return withClient(callerId, async c => {
    const r = (await c.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
    return { isError: r.isError === true, text: r.content.map(x => x.text).join("\n") }
  })
}

const install = (dir: string) => call(undefined, "app_install", { dir })

async function toolCallRoute(appId: string, tool: string, callerId?: string) {
  const res = await fetch(`${gateway.url}/apps/${encodeURIComponent(appId)}/tool-call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(callerId !== undefined ? { "x-agentproto-caller-session-id": callerId } : {}),
    },
    body: JSON.stringify({ tool, args: { q: "z" } }),
  })
  const body = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean }
  return { status: res.status, isError: body.isError === true, text: body.content.map(c => c.text).join("\n") }
}

/** A consumer app with one agent and `requires.apps`, returning its dir and the agent's AGENT.md path. */
async function buildConsumer(id: string, apps: unknown[]): Promise<{ dir: string; agentPath: string }> {
  const dir = await mkdtemp(join(home, "consumer-"))
  await defineApp({
    id,
    name: id,
    version: "1.0.0",
    agents: [
      {
        agent: defineAgent({ schema: "agent/v1", id: "scout", description: "Scout.", model: "claude-sonnet-5" }),
        body: "Scout.",
      },
    ],
    requires: { apps: apps as never },
  }).emit(dir)
  const appMd = matter(await readFile(join(dir, ".agentproto", "APP.md"), "utf8")).data as {
    agents: Array<{ path: string }>
  }
  return { dir, agentPath: join(dir, appMd.agents[0]!.path) }
}

const appList = async () =>
  JSON.parse((await call(undefined, "app_list", { full: true })).text) as Array<{
    appId: string
    unmetRequires?: unknown
  }>

async function setMode(mode: string): Promise<void> {
  await mkdir(join(homedir(), ".agentproto"), { recursive: true })
  await writeFile(join(homedir(), ".agentproto", "config.json"), JSON.stringify({ defaults: { apps: { exposedTools: mode } } }))
}

function spawnCaller(extra: Record<string, unknown> = {}): string {
  const agentSession = (): AgentSessionLike =>
    ({ sessionId: "acp", async *send() {}, async cancel() {}, async close() {} }) as AgentSessionLike
  return gateway.sessions.spawnAgent({
    workspaceSlug: "default",
    cwd: workspace,
    agentSession: agentSession(),
    adapterSlug: "mock",
    ...extra,
  }).id
}

describe("exposes.tools on the /mcp gateway", () => {
  it("lists the read tool right after app_install, with no restart, and runs it through the bundled driver", async () => {
    expect(await listTools()).not.toContain("jobkit_list")
    const res = await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    expect(res.isError, res.text).toBe(false)

    expect(await listTools()).toContain("jobkit_list")
    const out = await call(undefined, "jobkit_list", { q: "acme" })
    expect(out.isError, out.text).toBe(false)
    expect(JSON.parse(out.text)).toEqual({ listed: true, q: "acme" })
  })

  it("hides a write tool from a caller without opt-in and shows it to a caller that opted in", async () => {
    await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    const plain = spawnCaller()
    const optedIn = spawnCaller({ exposedToolOptIn: ["jobkit_leads_upsert"] })
    const otherName = spawnCaller({ exposedToolOptIn: ["jobkit_list"] })

    expect(await listTools()).not.toContain("jobkit_leads_upsert")
    expect(await listTools(plain)).not.toContain("jobkit_leads_upsert")
    expect(await listTools(plain)).toContain("jobkit_list")
    expect(await listTools(optedIn)).toContain("jobkit_leads_upsert")
    expect(await listTools(otherName)).not.toContain("jobkit_leads_upsert")

    const out = await call(optedIn, "jobkit_leads_upsert", { q: "x" })
    expect(out.isError, out.text).toBe(false)
    expect(JSON.parse(out.text)).toEqual({ upserted: true, q: "x" })
  })

  it("a deny grant blocks the call even for an opted-in caller (the tools go through the deny gate)", async () => {
    await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    const denied = spawnCaller({
      exposedToolOptIn: ["jobkit_leads_upsert"],
      toolDenyGrants: [
        { principal: "*", effect: "deny", actions: [{ action: "tool:invoke", scope: "agentproto/jobkit_list" }] },
        { principal: "*", effect: "deny", actions: [{ action: "tool:invoke", scope: "agentproto/jobkit_leads_upsert" }] },
      ],
    })
    for (const name of ["jobkit_list", "jobkit_leads_upsert"]) {
      const res = await call(denied, name, { q: "x" })
      expect(res.isError).toBe(true)
      expect(res.text).toContain("tool_denied")
    }
    expect((await call(undefined, "jobkit_list", { q: "x" })).isError).toBe(false)
  })

  it("?denyTools removes an exposed tool from the list", async () => {
    await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    const url = new URL(`${gateway.url}/mcp?denyTools=jobkit_list`)
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(url))
    try {
      expect((await client.listTools()).tools.map(t => t.name)).not.toContain("jobkit_list")
    } finally {
      await client.close()
    }
  })

  it("refuses a second app that claims an installed prefix; reinstalling the same appId is fine", async () => {
    expect((await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))).isError).toBe(false)

    const clash = await install(await buildApp({ id: "@test/other", prefix: "jobkit" }))
    expect(clash.isError).toBe(true)
    expect(clash.text).toContain("exposed-prefix-taken")

    const again = await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    expect(again.isError, again.text).toBe(false)
  })

  it("refuses at install a prefix that is the first segment of a daemon tool", async () => {
    const res = await install(await buildApp({ id: "@test/sess", prefix: "session" }))
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/reserved/)
  })

  it("defaults.apps.exposedTools: off hides everything, all shows write to a caller with no opt-in", async () => {
    await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    const plain = spawnCaller()

    await setMode("off")
    expect(await listTools(plain)).not.toContain("jobkit_list")

    await setMode("all")
    const names = await listTools(plain)
    expect(names).toContain("jobkit_list")
    expect(names).toContain("jobkit_leads_upsert")

    await setMode("read")
    expect(await listTools(plain)).not.toContain("jobkit_leads_upsert")
  })

  it("POST /apps/:appId/tool-call serves an exposed id that is not in ui.tools, under the same kill-switch", async () => {
    await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    const caller = spawnCaller()

    const read = await toolCallRoute("@test/jobkit", "jobkit.list")
    expect(read.isError, read.text).toBe(false)
    expect(JSON.parse(read.text)).toEqual({ listed: true, q: "z" })

    await setMode("read")
    const writeInRead = await toolCallRoute("@test/jobkit", "jobkit.leads.upsert", caller)
    expect(writeInRead.isError).toBe(true)
    expect(writeInRead.text).toContain("does not opt in")

    await setMode("all")
    expect(JSON.parse((await toolCallRoute("@test/jobkit", "jobkit.leads.upsert", caller)).text)).toEqual({
      upserted: true,
      q: "z",
    })

    await setMode("off")
    expect((await toolCallRoute("@test/jobkit", "jobkit.list")).isError).toBe(true)
  })

  it("POST /apps/:appId/tool-call refuses a write exposed tool without a caller session or without an opt-in; a read still works", async () => {
    await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    const plain = spawnCaller()
    const optedIn = spawnCaller({ exposedToolOptIn: ["jobkit_leads_upsert"] })

    const anonymous = await toolCallRoute("@test/jobkit", "jobkit.leads.upsert")
    expect(anonymous.isError).toBe(true)
    expect(anonymous.text).toContain("needs a caller session")

    const noOptIn = await toolCallRoute("@test/jobkit", "jobkit.leads.upsert", plain)
    expect(noOptIn.isError).toBe(true)
    expect(noOptIn.text).toContain("does not opt in")

    const ok = await toolCallRoute("@test/jobkit", "jobkit.leads.upsert", optedIn)
    expect(ok.isError, ok.text).toBe(false)
    expect(JSON.parse(ok.text)).toEqual({ upserted: true, q: "z" })

    // Even mode `all` does not open a write tool to an anonymous request.
    await setMode("all")
    expect((await toolCallRoute("@test/jobkit", "jobkit.leads.upsert")).isError).toBe(true)

    expect(JSON.parse((await toolCallRoute("@test/jobkit", "jobkit.list")).text)).toEqual({ listed: true, q: "z" })
  })

  it("requires.apps[].tools grants a provider write tool to the consumer's own agents and to no other session", async () => {
    await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    const consumer = await buildConsumer("@test/pyg", [{ id: "@test/jobkit", tools: ["jobkit_leads_upsert"] }])
    const res = await install(consumer.dir)
    expect(res.isError, res.text).toBe(false)
    expect(JSON.parse(res.text).unmetRequires).toBeUndefined()

    const appAgent = spawnCaller({ meta: { appAgent: "@test/pyg" } })
    const fromManifest = spawnCaller({ meta: { agentManifestPath: consumer.agentPath } })
    const unrelated = spawnCaller()
    const otherApp = spawnCaller({ meta: { appAgent: "@test/jobkit" } })

    expect(await listTools(appAgent)).toContain("jobkit_leads_upsert")
    expect(await listTools(fromManifest)).toContain("jobkit_leads_upsert")
    expect(await listTools(unrelated)).not.toContain("jobkit_leads_upsert")
    expect(await listTools(otherApp)).not.toContain("jobkit_leads_upsert")
    expect(await listTools()).not.toContain("jobkit_leads_upsert")

    const out = await call(appAgent, "jobkit_leads_upsert", { q: "g" })
    expect(out.isError, out.text).toBe(false)
    expect(JSON.parse(out.text)).toEqual({ upserted: true, q: "g" })

    // The REST twin honours the same grant, and nothing for another session.
    expect((await toolCallRoute("@test/jobkit", "jobkit.leads.upsert", appAgent)).isError).toBe(false)
    expect((await toolCallRoute("@test/jobkit", "jobkit.leads.upsert", unrelated)).isError).toBe(true)

    // The operator's off setting wins over a grant.
    await setMode("off")
    expect(await listTools(appAgent)).not.toContain("jobkit_leads_upsert")
  })

  it("a deny grant wins over a requires.apps grant", async () => {
    await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    const consumer = await buildConsumer("@test/pyg", [{ id: "@test/jobkit", tools: ["jobkit_leads_upsert"] }])
    await install(consumer.dir)
    const denied = spawnCaller({
      meta: { appAgent: "@test/pyg" },
      toolDenyGrants: [
        { principal: "*", effect: "deny", actions: [{ action: "tool:invoke", scope: "agentproto/jobkit_leads_upsert" }] },
      ],
    })
    const res = await call(denied, "jobkit_leads_upsert", { q: "x" })
    expect(res.isError).toBe(true)
    expect(res.text).toContain("tool_denied")
  })

  it("refuses to install a consumer whose requires.apps[].tools names a tool the installed provider does not expose", async () => {
    await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    const consumer = await buildConsumer("@test/pyg", [{ id: "@test/jobkit", tools: ["jobkit_list", "jobkit_delete"] }])
    const res = await install(consumer.dir)
    expect(res.isError).toBe(true)
    expect(res.text).toContain('requires.apps[0].tools[1]: \\"jobkit_delete\\" is not exposed by \\"@test/jobkit\\"')
    expect((await appList()).some(a => a.appId === "@test/pyg")).toBe(false)
  })

  it("installs a consumer whose provider is missing, reports it in unmetRequires and grants nothing until the provider is installed", async () => {
    const consumer = await buildConsumer("@test/pyg", [{ id: "@test/jobkit", tools: ["jobkit_leads_upsert"] }])
    const res = await install(consumer.dir)
    expect(res.isError, res.text).toBe(false)
    expect(JSON.parse(res.text).unmetRequires).toEqual([{ id: "@test/jobkit", reason: "not-installed" }])
    expect((await appList()).find(a => a.appId === "@test/pyg")?.unmetRequires).toEqual([
      { id: "@test/jobkit", reason: "not-installed" },
    ])
    const appAgent = spawnCaller({ meta: { appAgent: "@test/pyg" } })

    await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    expect(await listTools(appAgent)).toContain("jobkit_leads_upsert")
    expect((await appList()).find(a => a.appId === "@test/pyg")?.unmetRequires).toBeUndefined()

    const removed = await call(undefined, "app_uninstall", { appId: "@test/jobkit" })
    expect(removed.isError, removed.text).toBe(false)
    expect(await listTools(appAgent)).not.toContain("jobkit_leads_upsert")
    expect((await appList()).find(a => a.appId === "@test/pyg")?.unmetRequires).toEqual([
      { id: "@test/jobkit", reason: "not-installed" },
    ])
    // The consumer still reloads with its provider gone.
    expect((await install(consumer.dir)).isError).toBe(false)
  })

  it("a version range the provider does not satisfy grants nothing and is reported as version-mismatch", async () => {
    await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    const consumer = await buildConsumer("@test/pyg", [
      { id: "@test/jobkit", version: "^9", tools: ["jobkit_leads_upsert"] },
    ])
    const res = await install(consumer.dir)
    expect(res.isError, res.text).toBe(false)
    expect(JSON.parse(res.text).unmetRequires).toEqual([
      { id: "@test/jobkit", reason: "version-mismatch", installed: "0.1.0" },
    ])
    expect(await listTools(spawnCaller({ meta: { appAgent: "@test/pyg" } }))).not.toContain("jobkit_leads_upsert")
  })

  it("leaves the built-in tool set untouched: installing an app only adds its own prefixed tools", async () => {
    const before = (await listTools()).sort()
    await install(await buildApp({ id: "@test/jobkit", prefix: "jobkit" }))
    const after = (await listTools()).sort()
    expect(after.filter(n => !n.startsWith("jobkit_"))).toEqual(before)
    expect(after.filter(n => n.startsWith("jobkit_"))).toEqual(["jobkit_list"])
    expect(DAEMON_TOOL_NAMES.some(n => n.startsWith("jobkit_"))).toBe(false)
  })
})
