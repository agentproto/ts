/**
 * MCP Skills extension (beta) on the modern era of `/mcp`: `skills/list`,
 * `skills/get` and `skill://` reads through `resources/read`, served from the
 * imported-skills registry only. Fixtures under `fixtures/mcp-skills-ext-beta/`
 * pin the wire shapes; bump their version tag when the extension changes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { MODERN_PROTOCOL_VERSION } from "../mcp-modern/index.js"
import { createSkillsCatalog, registerServedSkills } from "../mcp-modern/skills.js"
import { importSkill, resyncImportedSkill, loadImportedSkills, saveImportedSkills } from "../skill-imports.js"

type Json = Record<string, any>

const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "skills-test", version: "0.0.1" },
  "io.modelcontextprotocol/clientCapabilities": {},
}
const EXT = "io.modelcontextprotocol/skills"
const fixture = async (name: string): Promise<Json> =>
  (JSON.parse(await readFile(new URL(`./fixtures/mcp-skills-ext-beta/${name}`, import.meta.url), "utf8")) as Json).result
const keys = (o: Json): string[] => Object.keys(o).filter(k => k !== "_meta").sort()
const sha = (b: Uint8Array | string) => `sha256:${createHash("sha256").update(b).digest("hex")}`

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

async function writeSkill(dir: string, name: string, extraFm = "", files: Record<string, string | Buffer> = {}, body = "Body.\n") {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Skill ${name}\n${extraFm}---\n${body}`)
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true })
    await writeFile(join(dir, rel), content)
  }
}

describe("MCP Skills extension on /mcp (modern era)", () => {
  let work = ""
  let registryPath = ""
  let root = ""
  let port = 0
  let stop: () => Promise<void> = async () => {}
  let skillsEnabled = true
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01])
  const url = () => `http://127.0.0.1:${port}/mcp`

  async function rpc(method: string, params: Json = {}, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
    const res = await fetch(url(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
        "mcp-method": method,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
    })
    return { status: res.status, json: JSON.parse(await res.text()) as Json }
  }
  const read = (uri: string) => rpc("resources/read", { uri }, { "mcp-name": uri })

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "mcp-skills-"))
    registryPath = join(work, "imported-skills.json")
    root = join(work, "skills")
    const paths = { registryPath, root }
    await writeSkill(join(work, "src-alpha"), "alpha", "license: MIT\nmetadata:\n  tier: beta\n", {
      "assets/logo.bin": binary,
      "docs/guide.md": "# Guide\n",
      "nested/SKILL.md": "---\nname: nested\ndescription: inner\n---\ninner\n",
    }, "Alpha body.\n")
    await writeSkill(join(work, "src-beta"), "beta")
    await importSkill({ sourcePath: join(work, "src-alpha"), alias: "alpha-display" }, paths)
    await importSkill({ sourcePath: join(work, "src-beta") }, paths)

    port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "skills-test", version: "1.0.0" })).server,
      mcpModern: {
        enabled: true,
        extensions: {},
        decorateServer: server => {
          if (skillsEnabled) registerServedSkills(server, paths)
        },
      },
      conversations: { async open() {}, async appendTurn() {}, async read() { return { meta: {} as never, turns: [] } }, async list() { return [] }, pathFor: (id: string) => id },
      events: createRuntimeEvents(),
      heartbeat: { start() {}, stop() {}, async fireNow() {} },
      meta: { workspace: process.cwd(), registered: [] },
    })
    stop = () => http.stop()
  })

  afterAll(async () => {
    await stop()
    await rm(work, { recursive: true, force: true })
  })

  it("announces the extension and the resources capability in server/discover", async () => {
    const r = await rpc("server/discover")
    expect(r.status).toBe(200)
    expect(r.json.result.capabilities.extensions[EXT]).toEqual({})
    expect(r.json.result.capabilities.resources).toBeDefined()
  })

  it("lists skills by NAME with the exact result shape, frontmatter verbatim, raw-byte digests", async () => {
    const r = await rpc("skills/list")
    expect(r.status).toBe(200)
    const result = r.json.result
    expect(result.resultType).toBe("complete")
    expect(result.ttlMs).toBe(0)
    expect(result.cacheScope).toBe("private")
    expect(result.nextCursor).toBeUndefined()
    const alpha = result.skills.find((s: Json) => s.frontmatter.name === "alpha")
    expect(alpha.uri).toBe("skill://alpha/SKILL.md") // the name, never the alias
    expect(JSON.stringify(result)).not.toContain("alpha-display")
    expect(alpha.frontmatter).toEqual({ name: "alpha", description: "Skill alpha", license: "MIT", metadata: { tier: "beta" } })
    const byUri = Object.fromEntries(alpha.resources.map((x: Json) => [x.uri, x]))
    expect(Object.keys(byUri).sort()).toEqual([
      "skill://alpha/SKILL.md",
      "skill://alpha/assets/logo.bin",
      "skill://alpha/docs/guide.md",
      "skill://alpha/nested/SKILL.md",
    ])
    const raw = await readFile(join(root, "alpha", "assets", "logo.bin"))
    expect(byUri["skill://alpha/assets/logo.bin"]).toEqual({ uri: "skill://alpha/assets/logo.bin", digest: sha(raw), size: raw.length })
    const md = await readFile(join(root, "alpha", "SKILL.md"))
    expect(byUri["skill://alpha/SKILL.md"].digest).toBe(sha(md))
  })

  it("matches the versioned beta fixtures (key sets of result, skill, resource)", async () => {
    const list = (await rpc("skills/list")).json.result
    const fixtureList = await fixture("skills-list-result.json")
    expect(keys(list)).toEqual(keys(fixtureList))
    expect(keys(list.skills[0])).toEqual(keys(fixtureList.skills[0]))
    expect(keys(list.skills[0].resources[0])).toEqual(keys(fixtureList.skills[0].resources[0]))
    const get = (await rpc("skills/get", { uri: "skill://beta/SKILL.md" })).json.result
    const fixtureGet = await fixture("skills-get-result.json")
    expect(keys(get)).toEqual(keys(fixtureGet))
    expect(keys(get.skill)).toEqual(keys(fixtureGet.skill))
  })

  it("skills/get answers {skill, ttlMs, cacheScope}, not the flat skill", async () => {
    const r = await rpc("skills/get", { uri: "skill://beta/SKILL.md" })
    expect(r.status).toBe(200)
    expect(r.json.result.skill.uri).toBe("skill://beta/SKILL.md")
    expect(r.json.result.skill.frontmatter.name).toBe("beta")
    expect(r.json.result).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" })
    expect(r.json.result.uri).toBeUndefined()
  })

  it("reads SKILL.md as exact text and a binary file as base64", async () => {
    const md = await readFile(join(root, "alpha", "SKILL.md"), "utf8")
    const t = await read("skill://alpha/SKILL.md")
    expect(t.status).toBe(200)
    expect(t.json.result.contents).toEqual([{ uri: "skill://alpha/SKILL.md", mimeType: "text/markdown", text: md }])
    expect(t.json.result).toMatchObject({ ttlMs: 0, cacheScope: "private" })
    const b = await read("skill://alpha/assets/logo.bin")
    const [content] = b.json.result.contents
    expect(content.text).toBeUndefined()
    expect(Buffer.from(content.blob, "base64").equals(binary)).toBe(true)
    expect(sha(Buffer.from(content.blob, "base64"))).toBe(
      (await rpc("skills/get", { uri: "skill://alpha/SKILL.md" })).json.result.skill.resources.find((x: Json) => x.uri.endsWith("logo.bin")).digest,
    )
  })

  it("refuses traversal, unlisted files and an escaping symlink with -32602 before reading", async () => {
    await writeFile(join(work, "outside.txt"), "secret")
    await symlink(join(work, "outside.txt"), join(root, "alpha", "leak.txt"))
    for (const uri of [
      "skill://alpha/%2e%2e/beta/SKILL.md",
      "skill://alpha/docs%2f..%2f..%2fbeta/SKILL.md",
      "skill://alpha/not-listed.txt",
      "skill://alpha/leak.txt",
      "skill://ghost/SKILL.md",
      // The scheme is case-insensitive: an uppercase one is still a Skills read, refused the same way.
      "SKILL://alpha/not-listed.txt",
    ]) {
      const r = await read(uri)
      expect(r.json.error?.code, uri).toBe(-32602)
      // AIP-77 "Error mapping": -32602 is HTTP 400 on the modern era.
      expect(r.status, uri).toBe(400)
    }
    const list = await rpc("skills/list")
    const alpha = list.json.result.skills.find((s: Json) => s.frontmatter.name === "alpha")
    expect(alpha.resources.some((x: Json) => x.uri.endsWith("leak.txt"))).toBe(false)
    for (const uri of ["skill://alpha/../beta/SKILL.md", "skill://alpha/docs/guide.md"]) {
      const r = await rpc("skills/get", { uri })
      expect(r.json.error.code, uri).toBe(-32602)
      expect(r.status, uri).toBe(400)
    }
  })

  it("keeps the served digest until skill_resync, then changes it", async () => {
    const digestOf = async () =>
      (await rpc("skills/get", { uri: "skill://beta/SKILL.md" })).json.result.skill.resources[0].digest as string
    const before = await digestOf()
    await writeFile(join(work, "src-beta", "SKILL.md"), "---\nname: beta\ndescription: Skill beta\n---\nChanged.\n")
    expect(await digestOf()).toBe(before)
    await resyncImportedSkill("beta", { registryPath, root })
    const after = await digestOf()
    expect(after).not.toBe(before)
    const text = (await read("skill://beta/SKILL.md")).json.result.contents[0].text as string
    expect(sha(text)).toBe(after)
  })

  it("does not serve or announce the extension when switched off", async () => {
    skillsEnabled = false
    try {
      const d = await rpc("server/discover")
      expect(d.json.result.capabilities.extensions?.[EXT]).toBeUndefined()
      const r = await rpc("skills/list")
      expect(r.status).toBe(404)
      expect(r.json.error.code).toBe(-32601)
    } finally {
      skillsEnabled = true
    }
  })

  it("does not mount on the legacy 2025-11-25 era", async () => {
    const res = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "0" } },
      }),
    })
    const text = await res.text()
    expect(text).not.toContain(EXT)
  })
})

describe("skills catalog (unit)", () => {
  let work = ""
  const paths = () => ({ registryPath: join(work, "r.json"), root: join(work, "skills") })

  async function setup(names: string[], files: Record<string, string> = {}) {
    work = await mkdtemp(join(tmpdir(), "mcp-skills-unit-"))
    for (const n of names) {
      await writeSkill(join(work, `src-${n}`), n, "", files)
      await importSkill({ sourcePath: join(work, `src-${n}`) }, paths())
    }
  }
  const cleanup = async () => rm(work, { recursive: true, force: true })

  it("paginates with an opaque cursor, stable order, no cursor at the end", async () => {
    await setup(["a1", "b2", "c3"])
    try {
      const catalog = createSkillsCatalog({ ...paths(), pageSize: 2 })
      const first = (await catalog.list({})) as Json
      expect(first.skills).toHaveLength(2)
      expect(typeof first.nextCursor).toBe("string")
      const second = (await catalog.list({ cursor: first.nextCursor })) as Json
      expect(second.skills).toHaveLength(1)
      expect(second.nextCursor).toBeUndefined()
      expect([...first.skills, ...second.skills].map((s: Json) => s.frontmatter.name)).toEqual(["a1", "b2", "c3"])
      await expect(catalog.list({ cursor: "!!" })).rejects.toMatchObject({ code: -32602 })
    } finally {
      await cleanup()
    }
  })

  it("does not serve a skill above the file ceiling and says why", async () => {
    await setup(["big"], { "f1.txt": "1", "f2.txt": "2", "f3.txt": "3" })
    try {
      const catalog = createSkillsCatalog({ ...paths(), maxFiles: 3 })
      expect(((await catalog.list({})) as Json).skills).toEqual([])
      await expect(catalog.get({ uri: "skill://big/SKILL.md" })).rejects.toThrow(/more than 3 files/)
      expect((await catalog.unservable())[0]).toMatchObject({ id: "big" })
      const bytes = createSkillsCatalog({ ...paths(), maxBytes: 5 })
      await expect(bytes.get({ uri: "skill://big/SKILL.md" })).rejects.toThrow(/bytes/)
    } finally {
      await cleanup()
    }
  })

  it("serves a name once when the registry holds two entries with it", async () => {
    await setup(["twin"])
    try {
      const config = await loadImportedSkills(paths().registryPath)
      await saveImportedSkills({ ...config, imports: [config.imports[0]!, { ...config.imports[0]!, alias: "twin-2" }] }, paths().registryPath)
      const catalog = createSkillsCatalog(paths())
      expect(((await catalog.list({})) as Json).skills).toHaveLength(1)
      expect(await catalog.unservable()).toEqual([{ id: "twin", reason: expect.stringContaining("duplicate") }])
    } finally {
      await cleanup()
    }
  })

  it("lists nothing when the registry is empty", async () => {
    work = await mkdtemp(join(tmpdir(), "mcp-skills-unit-"))
    try {
      expect(await createSkillsCatalog(paths()).list({})).toEqual({ skills: [] })
    } finally {
      await cleanup()
    }
  })
})
