/**
 * codex `config.toml` → mcpServers mapping (codex-config.ts), and codex as
 * a discovery source (mcp-discovery.ts `scanCodex`).
 */
import { describe, expect, it } from "vitest"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseCodexMcpServers, parseToml } from "../codex-config.js"
import { discoverMcps } from "../mcp-discovery.js"

const CODEX_TOML = `
model = "gpt-5.5"   # trailing comment
approval_policy = 'on-request'

[mcp_servers.agentproto]
command = "agentproto"
args = ["mcp-bridge", "--port", "8123"]
env = { AGENTPROTO_TOKEN = "t0k", "WITH SPACE" = "x" }

[mcp_servers."guilde-prod"]
url = "https://guilde.example/mcp"
bearer_token_env_var = "GUILDE_TOKEN"
http_headers = { "X-Team" = "core" }
env_http_headers = { "X-Key" = "GUILDE_KEY" }

[mcp_servers.multi]
command = "node"
args = [
  "server.js", # first
  "--flag",
]
startup_timeout_sec = 20
enabled = true

[mcp_servers.multi.env]
DEBUG = "1"

[[profiles.list]]
name = "ignored"

[tools]
web_search = false
`

describe("parseCodexMcpServers", () => {
  it("maps stdio, http and nested-env entries onto the mcpServers shape", () => {
    const servers = parseCodexMcpServers(CODEX_TOML)
    expect(Object.keys(servers).sort()).toEqual(["agentproto", "guilde-prod", "multi"])
    expect(servers.agentproto).toEqual({
      command: "agentproto",
      args: ["mcp-bridge", "--port", "8123"],
      env: { AGENTPROTO_TOKEN: "t0k", "WITH SPACE": "x" },
    })
    expect(servers["guilde-prod"]).toEqual({
      url: "https://guilde.example/mcp",
      headers: {
        "X-Team": "core",
        "X-Key": "${GUILDE_KEY}",
        Authorization: "Bearer ${GUILDE_TOKEN}",
      },
    })
    expect(servers.multi).toEqual({
      command: "node",
      args: ["server.js", "--flag"],
      env: { DEBUG: "1" },
    })
  })

  it("returns {} when the file has no mcp_servers table", () => {
    expect(parseCodexMcpServers('model = "x"\n')).toEqual({})
  })

  it("parses strings, escapes, multi-line strings and numbers", () => {
    const t = parseToml(
      [
        'a = "q\\"uote\\u00e9"',
        "b = 'C:\\\\raw'",
        'c = """',
        "line1",
        'line2"""',
        "d = '''",
        "lit'''",
        "e = 1_000",
        "f = -2.5",
        "g = 1979-05-27",
      ].join("\n")
    )
    expect(t).toEqual({
      a: 'q"uoteé',
      b: "C:\\\\raw",
      c: "line1\nline2",
      d: "lit",
      e: 1000,
      f: -2.5,
      g: "1979-05-27",
    })
  })

  it("throws with a line number on malformed input", () => {
    expect(() => parseToml('ok = 1\nbad = "unterminated\n')).toThrow(/line 2/)
  })
})

describe("discoverMcps — codex source", () => {
  it("lists ~/.codex/config.toml servers as source codex, scope global", async () => {
    // vitest.setup.ts points $HOME at a fresh tmpdir per test.
    await mkdir(join(homedir(), ".codex"), { recursive: true })
    await writeFile(join(homedir(), ".codex", "config.toml"), CODEX_TOML)
    const found = (await discoverMcps()).filter(m => m.source === "codex")
    expect(found.map(m => [m.name, m.type, m.scope])).toEqual([
      ["agentproto", "stdio", "global"],
      ["guilde-prod", "http", "global"],
      ["multi", "stdio", "global"],
    ])
  })
})
