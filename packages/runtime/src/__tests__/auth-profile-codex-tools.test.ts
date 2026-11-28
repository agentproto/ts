/**
 * MCP coverage for the Codex profile fields: `auth_profile_create` takes
 * `codexHome` + a workspace pin, `auth_profile_update` sets/clears `codexHome`,
 * `auth_profile_list` shows both and the workspace TITLES of the profile's
 * login. A token never appears in any output. Temp HOME and temp login homes
 * only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerAuthProfileTools } from "../auth-profile-tools.js"

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
const ID_TOKEN = `${b64({ alg: "none" })}.${b64({
  "https://api.openai.com/auth": {
    chatgpt_account_id: "acct-solo",
    organizations: [
      { id: "org-1", title: "Team Space", role: "owner", is_default: true },
      { id: "org-2", title: "Solo Space", role: "owner", is_default: false },
    ],
  },
})}.sig`

let prevHome: string | undefined
let root: string
let loginHome: string

beforeEach(() => {
  prevHome = process.env.HOME
  root = mkdtempSync(join(tmpdir(), "agp-codex-tools-"))
  process.env.HOME = root
  loginHome = join(root, "codex-solo")
  mkdirSync(loginHome)
  writeFileSync(
    join(loginHome, "auth.json"),
    JSON.stringify({
      tokens: { access_token: "SECRET-ACCESS", refresh_token: "SECRET-REFRESH", id_token: ID_TOKEN, account_id: "acct-solo" },
    }),
  )
})
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  rmSync(root, { recursive: true, force: true })
})

async function makeClient() {
  const server = new McpServer({ name: "t", version: "0.0.1" })
  registerAuthProfileTools(server)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "c", version: "0.0.1" })
  await client.connect(ct)
  return client
}
function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const text = (result as { content?: Array<{ type: string; text?: string }> }).content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("no text")
  return JSON.parse(text)
}

describe("codex profile fields over MCP", () => {
  it("create → list shows codexHome, the workspace pin and the login's workspace titles, never a token", async () => {
    const client = await makeClient()
    const created = await client.callTool({
      name: "auth_profile_create",
      arguments: {
        id: "codex-solo",
        endpoint: "openai",
        method: "oauth-bearer",
        source: "codex",
        codexHome: loginHome,
        subaccount: { kind: "workspace", id: "acct-solo", name: "Solo Space" },
      },
    })
    expect(created.isError).toBeFalsy()
    expect(parse(created).profile).toMatchObject({ codexHome: loginHome, subaccount: { kind: "workspace", id: "acct-solo" } })

    const listed = await client.callTool({ name: "auth_profile_list", arguments: {} })
    const row = parse(listed).profiles.find((p: { id: string }) => p.id === "codex-solo")
    expect(row.codexHome).toBe(loginHome)
    expect(row.subaccount).toMatchObject({ kind: "workspace", id: "acct-solo" })
    expect(row.codexLogin.accountId).toBe("acct-solo")
    expect(row.codexLogin.workspaces.map((w: { title: string }) => w.title)).toEqual(["Team Space", "Solo Space"])
    const all = JSON.stringify(parse(listed)) + JSON.stringify(parse(created))
    expect(all).not.toContain("SECRET")
    await client.close()
  })

  it("list marks a missing login without failing", async () => {
    const client = await makeClient()
    await client.callTool({
      name: "auth_profile_create",
      arguments: { id: "codex-none", endpoint: "openai", method: "oauth-bearer", source: "codex", codexHome: join(root, "nope") },
    })
    const row = parse(await client.callTool({ name: "auth_profile_list", arguments: {} })).profiles.find(
      (p: { id: string }) => p.id === "codex-none",
    )
    expect(row.codexLogin).toEqual({ loggedIn: false })
    await client.close()
  })

  it("a profile without codexHome is listed exactly as before (no codexLogin)", async () => {
    const client = await makeClient()
    await client.callTool({
      name: "auth_profile_create",
      arguments: { id: "codex-local", endpoint: "openai", method: "oauth-bearer", source: "codex" },
    })
    const row = parse(await client.callTool({ name: "auth_profile_list", arguments: {} })).profiles.find(
      (p: { id: string }) => p.id === "codex-local",
    )
    expect(row).not.toHaveProperty("codexHome")
    expect(row).not.toHaveProperty("codexLogin")
    await client.close()
  })

  it("update sets then clears codexHome; a relative path is rejected", async () => {
    const client = await makeClient()
    await client.callTool({
      name: "auth_profile_create",
      arguments: { id: "codex-x", endpoint: "openai", method: "oauth-bearer", source: "codex" },
    })
    const set = await client.callTool({ name: "auth_profile_update", arguments: { id: "codex-x", codexHome: loginHome } })
    expect(parse(set).profile.codexHome).toBe(loginHome)
    const bad = await client.callTool({ name: "auth_profile_update", arguments: { id: "codex-x", codexHome: "rel/dir" } })
    expect(bad.isError).toBe(true)
    const cleared = await client.callTool({ name: "auth_profile_update", arguments: { id: "codex-x", codexHome: null } })
    expect(parse(cleared).profile).not.toHaveProperty("codexHome")
    await client.close()
  })

  it("auth_profile_import takes the home of a discovered Codex login", async () => {
    const client = await makeClient()
    const ok = await client.callTool({
      name: "auth_profile_import",
      arguments: { origin: "codex", endpoint: "openai", id: "codex-imported", codexHome: loginHome },
    })
    expect(ok.isError).toBeFalsy()
    expect(parse(ok).profile).toMatchObject({ id: "codex-imported", source: "codex", codexHome: loginHome })
    const none = await client.callTool({
      name: "auth_profile_import",
      arguments: { origin: "codex", endpoint: "openai", id: "codex-none", codexHome: join(root, "empty-home") },
    })
    expect(none.isError).toBe(true)
    await client.close()
  })
})
