import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import matter from "gray-matter"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { defineApp } from "@agentproto/app"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { createAppRegistry } from "../app-registry.js"
import { performExposedToolCall } from "../app-tools.js"
import type { GatewayHandle } from "../index.js"

const HERE = dirname(fileURLToPath(import.meta.url))

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

async function writeManifest(
  dir: string,
  kind: "tools" | "drivers",
  id: string,
  file: string,
  data: Record<string, unknown>,
) {
  const target = join(dir, ".agentproto", kind, id, file)
  await mkdir(join(target, ".."), { recursive: true })
  await writeFile(target, matter.stringify("", data), "utf8")
}

async function buildSecretExposedApp(baseDir: string, opts: { id: string; prefix: string }): Promise<string> {
  const dir = await mkdtemp(join(baseDir, "app-"))
  const toolId = `${opts.prefix}.ping`
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
          workflows: [{ ref: "ping-flow" }],
        }),
        body: "Work.",
      },
    ],
    workflows: [
      defineWorkflow({
        id: "ping-flow",
        name: "Ping",
        description: "Pings.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [{ id: "s", kind: "tool", tool: toolId }],
      }),
    ],
  }).emit(dir)

  const appMd = join(dir, ".agentproto", "APP.md")
  const exposesYaml = [
    "exposes:",
    `  prefix: ${opts.prefix}`,
    "  tools:",
    `    - { id: ${toolId}, access: read, description: "Ping with scoped secret." }`,
  ].join("\n")
  await writeFile(appMd, (await readFile(appMd, "utf8")).replace(/^---\n/, `---\n${exposesYaml}\n`), "utf8")

  await writeManifest(dir, "tools", toolId, "TOOL.md", {
    schema: "agentproto/tool/v1",
    id: toolId,
    name: toolId,
    description: "Ping tool.",
    version: "1.0.0",
    inputs: { type: "object", properties: { msg: { type: "string" } } },
    outputs: { type: "object", properties: { ok: { type: "boolean" }, auth: { type: "string" } } },
  })

  await writeManifest(dir, "drivers", `${toolId}-http`, "DRIVER.md", {
    schema: "agentproto/driver/v1",
    id: `${toolId}-http`,
    name: `${toolId} http driver`,
    description: "HTTP ping driver.",
    version: "1.0.0",
    kind: "http",
    auth: { state: { env: ["EXPOSED_SCOPED_TOKEN"] } },
    implements: [
      {
        tool: toolId,
        version: "1.0.0",
        metadata: { http: { endpoint: "/ping", method: "GET" } },
      },
    ],
    metadata: {
      http: {
        baseUrl: "https://api.example.invalid",
        defaultHeaders: { Authorization: "Bearer ${secrets.EXPOSED_SCOPED_TOKEN}" },
      },
    },
  })

  return dir
}

describe("performExposedToolCall secret forwarding", () => {
  let root: string
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    root = await mkdtemp(join(HERE, ".tmp-exposed-secrets-"))
    originalFetch = globalThis.fetch
    delete process.env.EXPOSED_SCOPED_TOKEN
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    delete process.env.EXPOSED_SCOPED_TOKEN
    await rm(root, { recursive: true, force: true })
  })

  it("forwards deps.secrets and deps.resolveSecrets to runTool without requiring process.env", async () => {
    const appDir = await buildSecretExposedApp(root, { id: "@test/secret-app", prefix: "secapp" })
    const registry = createAppRegistry({ persist: false })
    registry.upsertApp({
      appId: "@test/secret-app",
      name: "@test/secret-app",
      version: "0.1.0",
      description: "Secret app.",
      dir: appDir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      exposes: {
        prefix: "secapp",
        agents: [],
        workflows: [],
        tools: [{ id: "secapp.ping", access: "read", description: "Ping." }],
      },
    })

    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify({ ok: true, auth: headers.Authorization ?? "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    const res = await performExposedToolCall(
      registry,
      { appId: "@test/secret-app", id: "secapp.ping", args: {} },
      { resolveSecrets: async () => ({ EXPOSED_SCOPED_TOKEN: "scoped-token-xyz" }) },
    )
    const text = (res as { content: Array<{ text: string }>; isError?: boolean }).content[0]?.text ?? ""
    expect((res as { isError?: boolean }).isError).not.toBe(true)
    expect(JSON.parse(text)).toEqual({ ok: true, auth: "Bearer scoped-token-xyz" })
  })
})

describe("internalToolServerPromise invalidation on app_install / routine_reconcile", () => {
  let root: string
  let workspace: string
  let gateway: GatewayHandle

  beforeEach(async () => {
    root = await mkdtemp(join(HERE, ".tmp-cache-invalidation-"))
    workspace = await mkdtemp(join(root, "ws-"))
    vi.stubEnv("HOME", root)
    vi.stubEnv("AGENTPROTO_HOME", join(root, ".agentproto"))
    const { createGateway } = await import("../index.js")
    gateway = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(root, "sessions.json"),
    })
  })

  afterEach(async () => {
    await gateway.stop()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it("exposes a newly installed app's tool to routine_trigger without restarting the daemon", async () => {
    const appDir = await mkdtemp(join(root, "app-"))
    const toolId = "fresh.echo"
    await defineApp({
      id: "@test/fresh-app",
      name: "Fresh App",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "Worker.",
            model: "claude-sonnet-5",
            workflows: [{ ref: "echo-flow" }],
          }),
          body: "Work.",
        },
      ],
      workflows: [
        defineWorkflow({
          id: "echo-flow",
          name: "Echo",
          description: "Echoes.",
          version: "0.1.0",
          inputs: {},
          outputs: {},
          steps: [{ id: "s", kind: "tool", tool: toolId }],
        }),
      ],
    }).emit(appDir)

    const appMd = join(appDir, ".agentproto", "APP.md")
    const exposesYaml = [
      "exposes:",
      "  prefix: fresh",
      "  tools:",
      `    - { id: ${toolId}, access: read, description: "Echo." }`,
    ].join("\n")
    await writeFile(appMd, (await readFile(appMd, "utf8")).replace(/^---\n/, `---\n${exposesYaml}\n`), "utf8")

    await writeManifest(appDir, "tools", toolId, "TOOL.md", {
      schema: "agentproto/tool/v1",
      id: toolId,
      name: toolId,
      description: "Echo.",
      version: "1.0.0",
      inputs: { type: "object", properties: { msg: { type: "string" } } },
      outputs: { type: "object", properties: { echoed: { type: "string" } } },
    })
    await writeManifest(appDir, "drivers", `${toolId}-cli`, "DRIVER.md", {
      schema: "agentproto/driver/v1",
      id: `${toolId}-cli`,
      name: `${toolId} cli`,
      description: "CLI echo.",
      version: "1.0.0",
      kind: "cli",
      implements: [
        {
          tool: toolId,
          version: "*",
          metadata: {
            cli: {
              argv: ["-e", "console.log(JSON.stringify({ echoed: process.argv[1] }))", "${input.msg}"],
              outputFormat: "json",
            },
          },
        },
      ],
      metadata: { cli: { bin: process.execPath } },
    })

    // Write a routine targeting `fresh_echo` (before the app is installed)
    const routineDir = join(workspace, ".routines", "run-fresh-echo")
    await mkdir(routineDir, { recursive: true })
    await writeFile(
      join(routineDir, "ROUTINE.md"),
      matter.stringify("# run-fresh-echo\n", {
        schema: "routine/v1",
        id: "run-fresh-echo",
        description: "Trigger fresh_echo.",
        version: "1.0.0",
        schedule: { kind: "cron", cron: "0 1 * * *" },
        target: { tool: "fresh_echo", inputs: { msg: "hello" } },
        enabled: true,
      }),
      "utf8",
    )

    const client = new Client({ name: "test", version: "0" }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`)))
    try {
      // 1. Warm `internalToolServerPromise` BEFORE installing the app (triggers unknown daemon tool)
      const before = await client.callTool({
        name: "routine_trigger",
        arguments: { routineId: "run-fresh-echo" },
      })
      const beforeText = (before.content as Array<{ text?: string }>)[0]?.text ?? ""
      expect((JSON.parse(beforeText) as { error?: string }).error).toContain('unknown daemon tool "fresh_echo"')

      // 2. Install the app — must invalidate `internalToolServerPromise`
      const installed = await client.callTool({
        name: "app_install",
        arguments: { dir: appDir },
      })
      expect(installed.isError).not.toBe(true)

      // 3. Reconcile routines and trigger — `fresh_echo` MUST now dispatch without daemon restart
      await client.callTool({ name: "routine_reconcile", arguments: {} })
      const after = await client.callTool({
        name: "routine_trigger",
        arguments: { routineId: "run-fresh-echo" },
      })
      expect(after.isError).not.toBe(true)
      const afterText = (after.content as Array<{ text?: string }>)[0]?.text ?? ""
      const parsedAfter = JSON.parse(afterText) as { ok?: boolean; summary?: string }
      expect(parsedAfter.ok).toBe(true)
      expect(parsedAfter.summary).toContain('"echoed":"hello"')
    } finally {
      await client.close()
    }
  })
})
