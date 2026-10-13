/**
 * MCP-transport coverage for the skill-import tools: `skill_import`,
 * `skill_imported_list`, `skill_imported_remove`, `skill_resync`.
 *
 * Uses the real McpServer + InMemoryTransport harness and a temp HOME, so
 * the registry's default `~/.agentproto/...` paths resolve inside the
 * sandbox. Source skill folders are created under the same temp HOME.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { saveImportedSkills, skillImportDir, IMPORTED_SKILLS_ROOT } from "../skill-imports.js"

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

async function connect(register: (server: McpServer) => void) {
  const server = new McpServer({ name: "session-skill-tools-test-server", version: "0.0.0" })
  register(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "session-skill-tools-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, close: async () => client.close() }
}

let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-session-skill-tools-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

async function makeSkill(name: string, body = "one\n"): Promise<string> {
  const dir = join(home, `src-${name}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n\n${body}`)
  return dir
}

async function open() {
  const { client, close } = await connect(
    server => registerSessionTools(server, {
      registry: createSessionsRegistry({ persist: false }),
      workspace: process.cwd(),
    })
  )
  return { client, close }
}

describe("skill_imported_list — compact default / pagination", () => {
  it("page-walk with limit=2 covers exactly the unpaginated list", async () => {
    await saveImportedSkills({
      version: 1,
      imports: [
        { id: "sk-a", alias: "sk-a", sourcePath: "/x/a", sha: "a".repeat(64), addedAt: "2026-10-13T10:00:00.000Z" },
        { id: "sk-b", alias: "bee", sourcePath: "/x/b", sha: "b".repeat(64), addedAt: "2026-10-13T10:01:00.000Z" },
        { id: "sk-c", alias: "sk-c", sourcePath: "/x/c", sha: "c".repeat(64), addedAt: "2026-10-13T10:02:00.000Z" },
      ],
    })
    const { client, close } = await open()

    const unpaginated = parse(await client.callTool({ name: "skill_imported_list", arguments: {} }))
    expect(unpaginated.imports.map((e: { id: string }) => e.id)).toEqual(["sk-a", "sk-b", "sk-c"])
    expect(unpaginated.imports[1]).toEqual({
      id: "sk-b",
      alias: "bee",
      addedAt: "2026-10-13T10:01:00.000Z",
      sha: "b".repeat(64),
    })
    // sourcePath stays behind `full: true`.
    expect(JSON.stringify(unpaginated)).not.toContain("sourcePath")
    expect(unpaginated.items).toBeUndefined()
    expect(unpaginated.total).toBeUndefined()

    const union: string[] = []
    let cursor: string | undefined
    do {
      const page = parse(
        await client.callTool({
          name: "skill_imported_list",
          arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
        })
      )
      expect(page.total).toBe(3)
      union.push(...page.items.map((e: { id: string }) => e.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(union).toEqual(unpaginated.imports.map((e: { id: string }) => e.id))

    await close()
  })
})

describe("skill_import / skill_imported_remove round trip", () => {
  it("imports a folder, lists it, removes it, deletes the copy", async () => {
    const src = await makeSkill("ap-round-trip")
    const { client, close } = await open()

    const imported = parse(
      await client.callTool({ name: "skill_import", arguments: { path: src, alias: "friendly" } })
    )
    expect(imported).toMatchObject({ id: "ap-round-trip", alias: "friendly", sourcePath: await realpath(src) })
    expect(imported.sha).toMatch(/^[0-9a-f]{64}$/)

    const listed = parse(await client.callTool({ name: "skill_imported_list", arguments: {} }))
    expect(listed.imports).toHaveLength(1)
    expect(listed.imports[0].alias).toBe("friendly")

    const removed = parse(
      await client.callTool({ name: "skill_imported_remove", arguments: { id: "ap-round-trip" } })
    )
    expect(removed).toEqual({ ok: true, id: "ap-round-trip" })
    expect(existsSync(skillImportDir("ap-round-trip", IMPORTED_SKILLS_ROOT()))).toBe(false)

    const after = parse(await client.callTool({ name: "skill_imported_list", arguments: {} }))
    expect(after.imports).toHaveLength(0)

    await close()
  })

  it("surfaces an import error for a folder with no SKILL.md", async () => {
    const empty = join(home, "empty")
    await mkdir(empty, { recursive: true })
    const { client, close } = await open()

    const result = await client.callTool({ name: "skill_import", arguments: { path: empty } })
    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = (result as any).content.find((c: any) => c.type === "text").text
    expect(text).toMatch(/skill_import failed/)

    await close()
  })

  it("rejects an alias with path separators", async () => {
    const src = await makeSkill("ap-bad-alias")
    const { client, close } = await open()

    let rejected = false
    let isError = false
    try {
      const result = await client.callTool({
        name: "skill_import",
        arguments: { path: src, alias: "../evil" },
      })
      isError = Boolean((result as { isError?: boolean }).isError)
    } catch {
      rejected = true
    }
    expect(rejected || isError).toBe(true)

    const listed = parse(await client.callTool({ name: "skill_imported_list", arguments: {} }))
    expect(listed.imports).toHaveLength(0)

    await close()
  })
})

describe("skill_resync", () => {
  it("re-copies on source change and is a no-op when unchanged", async () => {
    const src = await makeSkill("ap-resync")
    const { client, close } = await open()

    await client.callTool({ name: "skill_import", arguments: { path: src } })

    const noop = parse(await client.callTool({ name: "skill_resync", arguments: { id: "ap-resync" } }))
    expect(noop.changed).toBe(false)

    await writeFile(join(src, "SKILL.md"), "---\nname: ap-resync\ndescription: d\n---\n\ntwo\n")
    const changed = parse(await client.callTool({ name: "skill_resync", arguments: { id: "ap-resync" } }))
    expect(changed.changed).toBe(true)

    await close()
  })

  it("errors for an unknown id", async () => {
    const { client, close } = await open()
    const result = await client.callTool({ name: "skill_resync", arguments: { id: "ghost" } })
    expect((result as { isError?: boolean }).isError).toBe(true)
    await close()
  })
})
