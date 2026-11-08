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
    const route = async (tool: string) => {
      const res = await fetch(`${gateway.url}/apps/${encodeURIComponent("@test/jobkit")}/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool, args: { q: "z" } }),
      })
      const body = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean }
      return { status: res.status, isError: body.isError === true, text: body.content.map(c => c.text).join("\n") }
    }

    const read = await route("jobkit.list")
    expect(read.isError, read.text).toBe(false)
    expect(JSON.parse(read.text)).toEqual({ listed: true, q: "z" })

    const writeInRead = await route("jobkit.leads.upsert")
    expect(writeInRead.isError).toBe(true)
    expect(writeInRead.text).toContain("exposedTools")

    await setMode("all")
    expect(JSON.parse((await route("jobkit.leads.upsert")).text)).toEqual({ upserted: true, q: "z" })

    await setMode("off")
    expect((await route("jobkit.list")).isError).toBe(true)
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
