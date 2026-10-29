/**
 * T15 on the file tools: node confinement next to the existing root
 * confinement, derived from the CALLER session's ground. A sealed sibling's
 * files and files above a sealed wall are absent (reads, writes, listings,
 * stat, delete); a missing or unknown caller is refused. Shared fixture.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"

import { HOST_CALLER, type CallerScope } from "../caller-scope.js"
import { registerFsTools } from "../fs-tools.js"
import { SESSION, buildCallerFixture, type CallerFixture } from "./caller-scope-fixture.js"

let fx: CallerFixture
beforeEach(() => {
  fx = buildCallerFixture()
})
afterEach(() => fx.cleanup())

async function harness(callerScope: CallerScope | undefined) {
  const server = new McpServer({ name: "test-fs", version: "0.0.1" })
  registerFsTools(server, { workspace: fx.base, callerScope, scopes: fx.scopes } as never)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
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

describe("file_read", () => {
  it("a sealed sibling's file is absent", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const res = await h.call("file_read", { path: "user/perso/diary.txt" })
    expect(res.isError).toBe(true)
    expect(res.text).not.toContain("PERSO-DIARY")
    await h.close()
  })

  it("a file above the sealed wall is absent, and so is another tree", async () => {
    const h = await harness(fx.caller(SESSION.perso))
    for (const path of ["user/root.txt", "user/notes/todo.txt", "company/agentik/plan.txt"]) {
      const res = await h.call("file_read", { path })
      expect(res.isError, path).toBe(true)
      expect(res.text).not.toMatch(/ROOT-ABOVE|NOTES-TODO|COMPANY-PLAN/)
    }
    await h.close()
  })

  it("an ancestor loses a sealed descendant but keeps an isolated one", async () => {
    const h = await harness(fx.caller(SESSION.userRoot))
    expect((await h.call("file_read", { path: "user/perso/diary.txt" })).isError).toBe(true)
    expect(await h.call("file_read", { path: "user/notes/todo.txt" })).toEqual({ isError: false, text: "NOTES-TODO" })
    await h.close()
  })

  it("reads inside its own node, plain subfolders included", async () => {
    const h = await harness(fx.caller(SESSION.perso))
    expect(await h.call("file_read", { path: "user/perso/diary.txt" })).toEqual({ isError: false, text: "PERSO-DIARY" })
    expect(await h.call("file_read", { path: "user/perso/journal/entry.txt" })).toEqual({
      isError: false,
      text: "PERSO-JOURNAL",
    })
    await h.close()
  })

  it("a dot-dot path that lands in a walled node is still refused", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const res = await h.call("file_read", { path: "user/notes/../perso/diary.txt" })
    expect(res.isError).toBe(true)
    expect(res.text).not.toContain("PERSO-DIARY")
    await h.close()
  })
})

describe("file_info and directory_list", () => {
  it("file_info on a walled file is absent", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    const res = await h.call("file_info", { path: "user/perso/diary.txt" })
    expect(res.isError).toBe(true)
    expect(res.text).not.toContain("size")
    await h.close()
  })

  it("listing a walled directory is absent", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    expect((await h.call("directory_list", { path: "user/perso" })).isError).toBe(true)
    await h.close()
  })

  it("a listing leaves out the walled entries, before pagination", async () => {
    const h = await harness(fx.caller(SESSION.userRoot))
    const all = await h.call("directory_list", { path: "user" })
    expect(all.text).toContain("notes")
    expect(all.text).toContain("root.txt")
    expect(all.text).not.toContain("perso")

    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await h.call("directory_list", { path: "user", limit: 1, ...(cursor ? { cursor } : {}) })
      expect(page.text).not.toContain("perso")
      const parsed = JSON.parse(page.text) as { items: string[]; nextCursor?: string }
      seen.push(...parsed.items)
      cursor = parsed.nextCursor
      if (!cursor) break
    }
    expect(seen.sort()).toEqual(["[DIR]  notes", "[FILE] TYPES.md", "[FILE] WORKSPACE.md", "[FILE] root.txt"].sort())
    await h.close()
  })

  it("a sealed node listing the shared parent sees neither the root tree nor the other tree", async () => {
    const h = await harness(fx.caller(SESSION.perso))
    const res = await h.call("directory_list", {})
    expect(res.text).toContain("free")
    expect(res.text).not.toContain("user")
    expect(res.text).not.toContain("company")
    await h.close()
  })
})

describe("write tools", () => {
  it("file_write and directory_create into a sealed sibling are refused and write nothing", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    expect((await h.call("file_write", { path: "user/perso/injected.txt", content: "x" })).isError).toBe(true)
    expect((await h.call("directory_create", { path: "user/perso/injected" })).isError).toBe(true)
    expect(existsSync(join(fx.user.perso, "injected.txt"))).toBe(false)
    expect(existsSync(join(fx.user.perso, "injected"))).toBe(false)
    await h.close()
  })

  it("writes inside its own node still work", async () => {
    const h = await harness(fx.caller(SESSION.notes))
    expect(await h.call("file_write", { path: "user/notes/new.txt", content: "hello" })).toEqual({
      isError: false,
      text: "ok",
    })
    expect(readFileSync(join(fx.user.notes, "new.txt"), "utf8")).toBe("hello")
    await h.close()
  })

  it("file_delete cannot reach a walled file, nor a folder that holds one", async () => {
    const h = await harness(fx.caller(SESSION.userRoot))
    expect((await h.call("file_delete", { path: "user/perso/diary.txt" })).isError).toBe(true)
    expect((await h.call("file_delete", { path: "user" })).isError).toBe(true)
    expect(existsSync(join(fx.user.perso, "diary.txt"))).toBe(true)
    expect((await h.call("file_delete", { path: "user/root.txt" })).isError).toBe(false)
    await h.close()
  })
})

describe("a missing or unknown caller is refused", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["file_read", { path: "free/free.txt" }],
    ["file_write", { path: "free/new.txt", content: "x" }],
    ["directory_list", { path: "free" }],
    ["file_info", { path: "free/free.txt" }],
    ["directory_create", { path: "free/dir" }],
    ["file_delete", { path: "free/free.txt" }],
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
        expect(res.text).not.toContain("FREE")
        expect(existsSync(join(fx.free, "new.txt"))).toBe(false)
        expect(existsSync(join(fx.free, "dir"))).toBe(false)
        expect(existsSync(join(fx.free, "free.txt"))).toBe(true)
        await h.close()
      })
    }
  }
})

describe("calls that are not walled", () => {
  it("a host call reads everything", async () => {
    const h = await harness(HOST_CALLER)
    expect(await h.call("file_read", { path: "user/perso/diary.txt" })).toEqual({ isError: false, text: "PERSO-DIARY" })
    expect((await h.call("directory_list", { path: "user" })).text).toContain("perso")
    await h.close()
  })

  it("a session whose ground lies in no declared tree keeps today's behaviour", async () => {
    const h = await harness(fx.caller(SESSION.free))
    expect(await h.call("file_read", { path: "user/perso/diary.txt" })).toEqual({ isError: false, text: "PERSO-DIARY" })
    expect((await h.call("directory_list", { path: "user" })).text).toContain("perso")
    await h.close()
  })
})
