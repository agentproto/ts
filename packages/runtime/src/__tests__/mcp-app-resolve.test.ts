/**
 * resolveMcpServer — CONTRACT §1 resolution order: session → project
 * (`.mcp.json`, `~/.claude.json` projects[cwd|ancestor], codex tomls) →
 * user (`~/.claude.json` top-level) → imports. First match wins.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveMcpServer } from "../mcp-app-resolve.js"

const ALIAS = "guilde"

let root: string
let home: string
let projA: string
let projB: string
let importsPath: string

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value))
}

function http(url: string): { type: string; url: string } {
  return { type: "http", url }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-app-resolve-"))
  home = join(root, "home")
  projA = join(root, "work", "projA")
  projB = join(root, "work", "projB")
  importsPath = join(home, ".agentproto", "imported-mcps.json")
  await mkdir(join(home, ".agentproto"), { recursive: true })
  await mkdir(join(home, ".codex"), { recursive: true })
  await mkdir(join(projA, "sub", ".codex"), { recursive: true })
  await mkdir(projB, { recursive: true })
})

const opts = () => ({ home, importedMcpsPath: importsPath })

async function writeAllScopes(): Promise<void> {
  await writeJson(join(projA, "sub", ".mcp.json"), { mcpServers: { [ALIAS]: http("https://dot-mcp/mcp") } })
  await writeJson(join(home, ".claude.json"), {
    mcpServers: { [ALIAS]: http("https://user/mcp") },
    projects: {
      [projA]: { mcpServers: { [ALIAS]: http("https://claude-projA/mcp") } },
      [projB]: { mcpServers: { [ALIAS]: http("https://claude-projB/mcp") } },
    },
  })
  await writeFile(
    join(projA, "sub", ".codex", "config.toml"),
    `[mcp_servers.${ALIAS}]\nurl = "https://codex-cwd/mcp"\n`
  )
  await writeFile(join(home, ".codex", "config.toml"), `[mcp_servers.${ALIAS}]\nurl = "https://codex-home/mcp"\n`)
  await writeJson(importsPath, {
    version: 1,
    imports: [
      {
        id: "claude-code:global:guilde",
        alias: ALIAS,
        addedAt: "2026-09-26T00:00:00.000Z",
        snapshot: {
          id: "claude-code:global:guilde",
          source: "claude-code",
          scope: "global",
          name: ALIAS,
          type: "http",
          url: "https://imported/mcp",
        },
      },
    ],
  })
}

describe("resolveMcpServer", () => {
  it("prefers the session's own mcpServers entry over every other scope", async () => {
    await writeAllScopes()
    const r = await resolveMcpServer(
      {
        cwd: join(projA, "sub"),
        mcpServers: [{ name: ALIAS, transport: "http", ref: "https://session/mcp", headers: { A: "1" } }],
      },
      "s1",
      ALIAS,
      opts()
    )
    expect(r).toMatchObject({
      source: "session",
      origin: "session:s1",
      config: { type: "http", url: "https://session/mcp", headers: { A: "1" } },
    })
  })

  it("maps a stdio session entry (ref = command) and brokers credentialRef headers", async () => {
    const stdio = await resolveMcpServer(
      { mcpServers: [{ name: ALIAS, transport: "stdio", ref: "guilde-mcp", args: ["--x"], env: { K: "v" } }] },
      "s1",
      ALIAS,
      opts()
    )
    expect(stdio?.config).toEqual({ type: "stdio", command: "guilde-mcp", args: ["--x"], env: { K: "v" } })

    const brokered = await resolveMcpServer(
      {
        mcpServers: [
          { name: ALIAS, transport: "http", ref: "https://s/mcp", headers: { Authorization: "static" }, credentialRef: "guilde/token" },
        ],
      },
      "s1",
      ALIAS,
      { ...opts(), resolveCredentialHeaders: async ref => ({ Authorization: `Bearer <${ref}>` }) }
    )
    expect(brokered?.config.headers).toEqual({ Authorization: "Bearer <guilde/token>" })
  })

  it("walks the project scope in order: .mcp.json → claude.json project → cwd codex → home codex", async () => {
    await writeAllScopes()
    const cwd = join(projA, "sub")
    const session = { cwd }
    const url = async () => (await resolveMcpServer(session, "s1", ALIAS, opts()))?.config.url

    expect(await url()).toBe("https://dot-mcp/mcp")

    await writeJson(join(cwd, ".mcp.json"), { mcpServers: {} })
    // cwd = projA/sub has no projects[] entry of its own → nearest ancestor projA.
    const viaAncestor = await resolveMcpServer(session, "s1", ALIAS, opts())
    expect(viaAncestor?.source).toBe("project")
    expect(viaAncestor?.config.url).toBe("https://claude-projA/mcp")

    await writeJson(join(home, ".claude.json"), {
      mcpServers: { [ALIAS]: http("https://user/mcp") },
      projects: { [projA]: { mcpServers: {} } },
    })
    expect(await url()).toBe("https://codex-cwd/mcp")

    await writeFile(join(cwd, ".codex", "config.toml"), "")
    const homeCodex = await resolveMcpServer(session, "s1", ALIAS, opts())
    expect(homeCodex?.source).toBe("project")
    expect(homeCodex?.config.url).toBe("https://codex-home/mcp")
  })

  it("falls through to user scope, then imports, then null", async () => {
    await writeAllScopes()
    await writeFile(join(home, ".codex", "config.toml"), "")
    // A session with no cwd skips the project scope entirely.
    const user = await resolveMcpServer({}, "s1", ALIAS, opts())
    expect(user).toMatchObject({ source: "user", config: { url: "https://user/mcp" } })

    await writeJson(join(home, ".claude.json"), { mcpServers: {} })
    const imported = await resolveMcpServer({}, "s1", ALIAS, opts())
    expect(imported).toMatchObject({ source: "imported", origin: importsPath, config: { type: "http", url: "https://imported/mcp" } })

    await writeJson(importsPath, { version: 1, imports: [] })
    expect(await resolveMcpServer({}, "s1", ALIAS, opts())).toBeNull()
  })

  it("resolves the same alias differently for sessions in two projects", async () => {
    await writeAllScopes()
    await writeJson(join(projA, "sub", ".mcp.json"), { mcpServers: {} })
    const a = await resolveMcpServer({ cwd: projA }, "sa", ALIAS, opts())
    const b = await resolveMcpServer({ cwd: projB }, "sb", ALIAS, opts())
    expect(a?.config.url).toBe("https://claude-projA/mcp")
    expect(b?.config.url).toBe("https://claude-projB/mcp")
  })

  it("skips a malformed config file instead of failing the lookup", async () => {
    await writeAllScopes()
    await writeFile(join(projA, "sub", ".mcp.json"), "{ not json")
    await writeFile(join(projA, "sub", ".codex", "config.toml"), "[[[ broken")
    const r = await resolveMcpServer({ cwd: join(projA, "sub") }, "s1", ALIAS, opts())
    expect(r?.config.url).toBe("https://claude-projA/mcp")
  })
})
