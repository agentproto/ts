/**
 * Call-time enforcement of an AGENT manifest's tool deny items (T3b).
 *
 * A session spawned from an AGENT.md with `{kind: mcp, server, deny: [...]}`
 * carries the matching AIP-38 `tool:invoke` deny grants on its descriptor
 * (`toolDenyGrants`). Two dispatch sites read them:
 *   - the `/mcp` gateway, for built-ins (`agentproto/<name>`), keyed on the
 *     request's `?callerSessionId=`;
 *   - the imported-call guard, for `<server>/<name>`.
 * The grants are deny-only: everything else keeps running. A session with no
 * field, and a host call with no caller id, are never evaluated. Real
 * `createGateway`, isolated HOME, temp dirs only.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { toolDenyGrants } from "@agentproto/operator"

import type { GatewayHandle } from "../index.js"
import { createImportedCallGuard } from "../imported-call-gate.js"
import { McpProxyRegistry } from "../mcp-proxy.js"
import type { AgentSessionLike, SessionDescriptor } from "../sessions.js"

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

const DENY_CRON_CREATE = toolDenyGrants([{ kind: "mcp", server: "agentproto", deny: ["cron_create"] }])
const cronArgs = (label: string) => ({ schedule: "0 9 * * 1-5", label, action: { kind: "tool", tool: "session_list" } })
const labelsOf = (text: string): string[] => (JSON.parse(text) as { jobs: Array<{ label?: string }> }).jobs.map(j => j.label ?? "")

let home = ""
let workspace = ""
let gateway: GatewayHandle
const ids = { denied: "", plain: "" }

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "tool-deny-gate-"))
  vi.stubEnv("HOME", home)
  vi.stubEnv("AGENTPROTO_HOME", join(home, ".agentproto"))
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

beforeEach(async () => {
  workspace = await mkdtemp(join(home, "ws-"))
  const { createGateway } = await import("../index.js")
  gateway = await createGateway({
    workspace,
    specs: [],
    port: await freePort(),
    boot: false,
    persist: false,
    persistPath: join(home, "sessions.json"),
  })
  const agentSession = (): AgentSessionLike =>
    ({ sessionId: "acp", async *send() {}, async cancel() {}, async close() {} }) as AgentSessionLike
  const spawn = (extra: Record<string, unknown>) =>
    gateway.sessions.spawnAgent({
      workspaceSlug: "default",
      cwd: workspace,
      agentSession: agentSession(),
      adapterSlug: "mock",
      ...extra,
    } as never).id
  ids.denied = spawn({ toolDenyGrants: DENY_CRON_CREATE })
  ids.plain = spawn({})
})
afterEach(async () => {
  await gateway.stop()
})

async function call(callerId: string | undefined, tool: string, args: Record<string, unknown>) {
  const url = new URL(`${gateway.url}/mcp${callerId !== undefined ? `?callerSessionId=${encodeURIComponent(callerId)}` : ""}`)
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(url))
  try {
    const r = (await client.callTool({ name: tool, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
    return { isError: r.isError === true, text: r.content.map(c => c.text).join("\n") }
  } finally {
    await client.close()
  }
}

describe("the /mcp gateway refuses a denied built-in at call time", () => {
  it("refuses agentproto/cron_create for the session that carries the deny grant, while another built-in still runs", async () => {
    const refused = await call(ids.denied, "cron_create", cronArgs("denied-probe"))
    expect(refused.isError).toBe(true)
    const body = JSON.parse(refused.text) as Record<string, unknown>
    expect(body).toMatchObject({ error: "tool_denied", tool: "agentproto/cron_create", rule: "policy.explicit-deny" })
    expect(String(body.reason)).toContain("agentproto/cron_create")
    expect(String(body.reason)).toMatch(/grant 0/)

    const listed = await call(ids.denied, "cron_list", {})
    expect(listed.isError).toBe(false)
    expect(labelsOf(listed.text)).not.toContain("denied-probe")
  })

  it("never created the cron job the refused call asked for", async () => {
    await call(ids.denied, "cron_create", cronArgs("never-created"))
    const listed = await call(undefined, "cron_list", {})
    expect(labelsOf(listed.text)).not.toContain("never-created")
  })

  it("lets a session with no deny grants, and a host call, create the same cron job (deny-only, never default deny)", async () => {
    const plain = await call(ids.plain, "cron_create", cronArgs("plain-probe"))
    expect(plain.isError).toBe(false)
    const host = await call(undefined, "cron_create", cronArgs("host-probe"))
    expect(host.isError).toBe(false)
    expect(JSON.parse(host.text)).toMatchObject({ schedule: "0 9 * * 1-5" })
  })

  it("refuses a denied tool that is registered outside the orchestration pass too (create_tool)", async () => {
    const denied = gateway.sessions.spawnAgent({
      workspaceSlug: "default",
      cwd: workspace,
      agentSession: { sessionId: "acp", async *send() {}, async cancel() {}, async close() {} } as AgentSessionLike,
      adapterSlug: "mock",
      toolDenyGrants: toolDenyGrants([{ kind: "mcp", server: "agentproto", deny: ["create_tool"] }]),
    } as never).id
    const res = await call(denied, "create_tool", { id: "probe-tool", description: "probe", driver: { kind: "cli", bin: "node", argv: ["probe.js"] } })
    expect(res.isError).toBe(true)
    expect(JSON.parse(res.text)).toMatchObject({ error: "tool_denied", tool: "agentproto/create_tool" })
  })
})

describe("parity: a session with no toolDenyGrants answers exactly as a host call", () => {
  it("returns the same outcome for the same calls", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["cron_list", {}],
      ["cron_create", { ...cronArgs("bad"), schedule: "not a cron" }],
      ["file_read", { path: "does-not-exist.txt" }],
      ["tool_help", { tool: "cron_list" }],
    ]
    const answers: string[][] = []
    for (const callerId of [undefined, ids.plain]) {
      const out: string[] = []
      for (const [tool, args] of calls) out.push(JSON.stringify(await call(callerId, tool, args)))
      answers.push(out)
    }
    expect(answers[1]).toEqual(answers[0])
  })

  it("a denied session answers every non-denied call as a host call does", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["cron_list", {}],
      ["file_read", { path: "does-not-exist.txt" }],
      ["tool_help", { tool: "cron_list" }],
    ]
    const answers: string[][] = []
    for (const callerId of [undefined, ids.denied]) {
      const out: string[] = []
      for (const [tool, args] of calls) out.push(JSON.stringify(await call(callerId, tool, args)))
      answers.push(out)
    }
    expect(answers[1]).toEqual(answers[0])
  })
})

describe("the imported-call guard refuses a denied <server>/<name>", () => {
  function proxyWith(descriptors: Record<string, Partial<SessionDescriptor>>) {
    const proxy = new McpProxyRegistry()
    const registry = {
      get: (id: string) => descriptors[id],
      requestToolPermission: vi.fn(),
    }
    proxy.setCallGuard(createImportedCallGuard({ registry: registry as never, workspace }))
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "sent" }] }))
    vi.spyOn(proxy as never, "connectIfNeeded" as never).mockImplementation((async () => ({
      alias: "agentpush",
      client: { callTool },
      tools: [],
    })) as never)
    return { proxy, callTool }
  }

  const deny = toolDenyGrants([{ kind: "mcp", server: "agentpush", deny: ["send_message"] }])
  const descriptors = {
    sess_denied: { id: "sess_denied", cwd: "/tmp", toolDenyGrants: deny },
    sess_plain: { id: "sess_plain", cwd: "/tmp" },
  } as Record<string, Partial<SessionDescriptor>>

  it("refuses the denied tool, names the tool and the grant, and never reaches the upstream", async () => {
    const { proxy, callTool } = proxyWith(descriptors)
    const out = await proxy.callTool("agentpush", "send_message", { to: "x" }, { callerSessionId: "sess_denied" })
    expect(out.ok).toBe(false)
    const error = (out as { error: string }).error
    expect(error).toContain("agentpush/send_message")
    expect(error).toMatch(/explicit deny/)
    expect(error).toMatch(/grant 0/)
    expect(callTool).not.toHaveBeenCalled()
  })

  it("still serves another tool of the same server for the same session", async () => {
    const { proxy, callTool } = proxyWith(descriptors)
    const out = await proxy.callTool("agentpush", "list_mail", {}, { callerSessionId: "sess_denied" })
    expect(out.ok).toBe(true)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it("does not apply a grant for one server to a same-named tool on another server", async () => {
    const { proxy, callTool } = proxyWith(descriptors)
    const out = await proxy.callTool("othermail", "send_message", {}, { callerSessionId: "sess_denied" })
    expect(out.ok).toBe(true)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it("serves a session with no field, and a host call, exactly as before", async () => {
    const { proxy, callTool } = proxyWith(descriptors)
    const plain = await proxy.callTool("agentpush", "send_message", {}, { callerSessionId: "sess_plain" })
    const host = await proxy.callTool("agentpush", "send_message", {})
    expect(plain.ok).toBe(true)
    expect(host.ok).toBe(true)
    expect(callTool).toHaveBeenCalledTimes(2)
  })
})
