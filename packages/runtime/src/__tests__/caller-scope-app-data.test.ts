/**
 * T15 on the app-data tools: an installed app that lives in a sealed sibling
 * (or above the caller's sealed wall, or in another tree) is not visible to the
 * caller, whatever its data. A missing or unknown caller is refused. Shared
 * fixture; apps registered in an in-memory registry over the fixture dirs.
 */

import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAppDataTools } from "../app-data.js"
import { createAppRegistry } from "../app-registry.js"
import { HOST_CALLER, type CallerScope } from "../caller-scope.js"
import { SESSION, buildCallerFixture, type CallerFixture } from "./caller-scope-fixture.js"

const DIARY = "@me/diary"
const TODO = "@me/todo"
const CRM = "@acme/crm"

let fx: CallerFixture
beforeEach(() => {
  fx = buildCallerFixture()
})
afterEach(() => fx.cleanup())

async function harness(callerScope: CallerScope | undefined) {
  const appRegistry = createAppRegistry()
  const dirs: Array<[string, string]> = [
    [DIARY, join(fx.user.perso, "apps", "diary")],
    [TODO, join(fx.user.notes, "apps", "todo")],
    [CRM, join(fx.company.agentik, "apps", "crm")],
  ]
  for (const [appId, dir] of dirs) {
    appRegistry.upsertApp({ appId, dir, agents: [], workflows: [], unvalidatedAgentTools: [] })
  }
  const server = new McpServer({ name: "app-data-test-server", version: "0.0.0" })
  registerAppDataTools(server, { appRegistry, callerScope, scopes: fx.scopes } as never)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "app-data-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  async function call(name: string, args: Record<string, unknown>) {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    return { isError: result.isError === true, text: result.content[0]!.text }
  }
  return { call, close: () => client.close() }
}

const READS: Array<[string, (appId: string) => Record<string, unknown>]> = [
  ["app_data_read", (appId) => ({ appId, path: "secret.json" })],
  ["app_data_list", (appId) => ({ appId })],
  ["app_state_get", (appId) => ({ appId })],
  ["app_state_list", (appId) => ({ appId })],
]

describe("app data of a sealed sibling is absent", () => {
  it("app_data_read, app_data_list, app_state_get and app_state_list report no such app", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    for (const [tool, args] of READS) {
      const res = await h.call(tool, args(DIARY))
      expect(res.isError, tool).toBe(true)
      expect(res.text, tool).toMatch(/no installed app/)
      expect(res.text, tool).not.toContain("PERSO-APP")
    }
    await h.close()
  })

  it("writes and migrations into it are refused and change nothing", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const write = await h.call("app_data_write", { appId: DIARY, path: "injected.json", content: { a: 1 } })
    expect(write.isError).toBe(true)
    expect((await h.call("app_data_migrate", { appId: DIARY })).isError).toBe(true)
    const host = await harness(HOST_CALLER)
    const listed = await host.call("app_data_list", { appId: DIARY })
    expect(listed.text).not.toContain("injected")
    await h.close()
    await host.close()
  })
})

describe("app data above the sealed wall, or in another tree, is absent", () => {
  it("a sealed node does not see the app of its sibling or of the company tree", async () => {
    const h = await harness(fx.caller(SESSION.perso))
    for (const appId of [TODO, CRM]) {
      const res = await h.call("app_data_read", { appId, path: "todo.json" })
      expect(res.isError, appId).toBe(true)
      expect(res.text).toMatch(/no installed app/)
      expect(res.text).not.toMatch(/NOTES-APP|COMPANY-APP/)
    }
    await h.close()
  })

  it("the ancestor loses a sealed descendant's app", async () => {
    const h = await harness(fx.caller(SESSION.userRoot))
    expect((await h.call("app_data_read", { appId: DIARY, path: "secret.json" })).isError).toBe(true)
    await h.close()
  })
})

describe("what is visible stays readable", () => {
  it("a session reads the data of an app in its own node", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const res = await h.call("app_data_read", { appId: TODO, path: "todo.json" })
    expect(res.isError).toBe(false)
    expect(res.text).toContain("NOTES-APP")
    await h.close()
  })

  it("the sealed node reads its own app", async () => {
    const h = await harness(fx.caller(SESSION.perso))
    const res = await h.call("app_data_read", { appId: DIARY, path: "secret.json" })
    expect(res.text).toContain("PERSO-APP")
    await h.close()
  })

  it("a host call and a session in no declared tree are not walled", async () => {
    for (const caller of [HOST_CALLER, fx.caller(SESSION.free)]) {
      const h = await harness(caller)
      const res = await h.call("app_data_read", { appId: DIARY, path: "secret.json" })
      expect(res.text).toContain("PERSO-APP")
      await h.close()
    }
  })
})

describe("a missing or unknown caller is refused", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["app_data_read", { appId: TODO, path: "todo.json" }],
    ["app_data_write", { appId: TODO, path: "x.json", content: {} }],
    ["app_data_list", { appId: TODO }],
    ["app_data_migrate", { appId: TODO }],
    ["app_state_get", { appId: TODO }],
    ["app_state_list", { appId: TODO }],
  ]
  for (const [label, scope] of [
    ["an unknown caller id", () => fx.caller(SESSION.ghost)],
    ["no caller scope at all", () => undefined],
  ] as const) {
    for (const [tool, args] of calls) {
      it(`${tool} refuses ${label}`, async () => {
        const h = await harness(scope())
        const res = await h.call(tool, args)
        expect(res.isError).toBe(true)
        expect(res.text).toMatch(/refused/i)
        expect(res.text).not.toContain("NOTES-APP")
        await h.close()
      })
    }
  }
})
