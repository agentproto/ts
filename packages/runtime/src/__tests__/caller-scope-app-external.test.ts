/**
 * T15 on the app_external tools: an installed app that lives in a node the
 * caller cannot see reads as "no installed app", and a granted external root
 * inside such a node reads as not granted. A missing or unknown caller is
 * refused. Shared fixture; apps registered in an in-memory registry.
 */

import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAppExternalTools } from "../app-external.js"
import { createAppRegistry } from "../app-registry.js"
import { HOST_CALLER, type CallerScope } from "../caller-scope.js"
import { SESSION, buildCallerFixture, type CallerFixture } from "./caller-scope-fixture.js"

const DIARY = "@me/diary"
const TODO = "@me/todo"
const CRM = "@acme/crm"
const BRIDGE = "@me/bridge"

let fx: CallerFixture
beforeEach(() => {
  fx = buildCallerFixture()
})
afterEach(() => fx.cleanup())

async function harness(callerScope: CallerScope | undefined) {
  const appRegistry = createAppRegistry()
  const apps: Array<[string, string, string[]]> = [
    [DIARY, join(fx.user.perso, "apps", "diary"), [join(fx.user.perso, "journal")]],
    [TODO, join(fx.user.notes, "apps", "todo"), [fx.user.notes]],
    [CRM, join(fx.company.agentik, "apps", "crm"), [fx.company.agentik]],
    [BRIDGE, join(fx.user.notes, "apps", "bridge"), [fx.user.perso]],
  ]
  for (const [appId, dir, externalReadRoots] of apps) {
    appRegistry.upsertApp({ appId, dir, agents: [], workflows: [], unvalidatedAgentTools: [], externalReadRoots } as never)
  }
  const server = new McpServer({ name: "app-external-test-server", version: "0.0.0" })
  registerAppExternalTools(server, { appRegistry, callerScope, scopes: fx.scopes })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "app-external-test-client", version: "0.0.0" })
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

const readOf = (appId: string, root: string, path: string) => ({ appId, root, path })

describe("an app in a node the caller cannot see is absent", () => {
  it("a sealed sibling's sibling does not see the sealed node's app", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const list = await h.call("app_external_list", { appId: DIARY, root: join(fx.user.perso, "journal") })
    expect(list.isError).toBe(true)
    expect(list.text).toMatch(/no installed app/)
    expect(list.text).not.toContain("entry.txt")
    const read = await h.call("app_external_read", readOf(DIARY, join(fx.user.perso, "journal"), "entry.txt"))
    expect(read.isError).toBe(true)
    expect(read.text).toMatch(/no installed app/)
    expect(read.text).not.toContain("PERSO-JOURNAL")
    await h.close()
  })

  it("a sealed node does not see an app of the company tree or its sibling", async () => {
    const h = await harness(fx.caller(SESSION.perso))
    for (const [appId, root, path] of [
      [TODO, fx.user.notes, "todo.txt"],
      [CRM, fx.company.agentik, "plan.txt"],
    ] as const) {
      const res = await h.call("app_external_read", readOf(appId, root, path))
      expect(res.isError, appId).toBe(true)
      expect(res.text).toMatch(/no installed app/)
      expect(res.text).not.toMatch(/NOTES-TODO|COMPANY-PLAN/)
    }
    await h.close()
  })

  it("the ancestor loses the sealed descendant's app", async () => {
    const h = await harness(fx.caller(SESSION.userRoot))
    const res = await h.call("app_external_read", readOf(DIARY, join(fx.user.perso, "journal"), "entry.txt"))
    expect(res.isError).toBe(true)
    expect(res.text).not.toContain("PERSO-JOURNAL")
    await h.close()
  })
})

describe("a granted root inside a node the caller cannot see is not granted", () => {
  it("a visible app whose granted root lies in the sealed node cannot read it", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const list = await h.call("app_external_list", { appId: BRIDGE, root: fx.user.perso })
    expect(list.isError).toBe(true)
    expect(list.text).toMatch(/not granted/)
    expect(list.text).not.toContain("diary.txt")
    const read = await h.call("app_external_read", readOf(BRIDGE, fx.user.perso, "diary.txt"))
    expect(read.isError).toBe(true)
    expect(read.text).not.toContain("PERSO-DIARY")
    await h.close()
  })
})

describe("what is visible stays readable", () => {
  it("a session reads the external root of an app in its own node", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const res = await h.call("app_external_read", readOf(TODO, fx.user.notes, "todo.txt"))
    expect(res.isError).toBe(false)
    expect(res.text).toContain("NOTES-TODO")
    await h.close()
  })

  it("the sealed node reads its own app's root", async () => {
    const h = await harness(fx.caller(SESSION.perso))
    const res = await h.call("app_external_read", readOf(DIARY, join(fx.user.perso, "journal"), "entry.txt"))
    expect(res.text).toContain("PERSO-JOURNAL")
    await h.close()
  })

  it("a host call and a session in no declared tree are not walled", async () => {
    for (const caller of [HOST_CALLER, fx.caller(SESSION.free)]) {
      const h = await harness(caller)
      const res = await h.call("app_external_read", readOf(DIARY, join(fx.user.perso, "journal"), "entry.txt"))
      expect(res.text).toContain("PERSO-JOURNAL")
      const list = await h.call("app_external_list", { appId: BRIDGE, root: fx.user.perso })
      expect(list.isError).toBe(false)
      await h.close()
    }
  })
})

describe("a missing or unknown caller is refused", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["app_external_list", { appId: TODO, root: "" }],
    ["app_external_read", { appId: TODO, root: "", path: "todo.txt" }],
  ]
  for (const [label, scope] of [
    ["an unknown caller id", () => fx.caller(SESSION.ghost)],
    ["no caller scope at all", () => undefined],
  ] as const) {
    for (const [tool, args] of calls) {
      it(`${tool} refuses ${label}`, async () => {
        const h = await harness(scope())
        const res = await h.call(tool, { ...args, root: fx.user.notes })
        expect(res.isError).toBe(true)
        expect(res.text).toMatch(/refused/i)
        expect(res.text).not.toContain("NOTES-TODO")
        await h.close()
      })
    }
  }
})
