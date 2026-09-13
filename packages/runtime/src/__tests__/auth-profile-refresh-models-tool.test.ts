/**
 * Thin wrapper tests for the `auth_profile_refresh_models` MCP tool
 * (auth-profile-tools.ts). The diff/refresh logic itself (drop stale ids,
 * add newly-eligible ones, reject mode:"all") is exhaustively covered in
 * `@agentproto/auth`'s `profile-provision.test.ts` — these only assert this
 * wrapper's happy path + its unknown-profile error shape.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { addAuthProfile } from "@agentproto/auth"
import { registerAuthProfileTools } from "../auth-profile-tools.js"
import { buildCatalogProviderModels } from "../catalog-provider-models.js"

// authProfilesPath() resolves under os.homedir() → $HOME on POSIX (same
// isolation profile-store.test.ts uses) — a temp HOME keeps this off the
// real ~/.agentproto/auth-profiles.json.
let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-auth-profile-refresh-tool-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

async function makeClient() {
  const server = new McpServer({ name: "test-auth-profile", version: "0.0.1" })
  registerAuthProfileTools(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, cleanup: () => client.close() }
}

describe("auth_profile_refresh_models", () => {
  it("re-syncs a mode:\"allow\" profile's ids against the current catalog", async () => {
    await addAuthProfile({
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "api-key",
      credentialRef: "agentproto.auth.anthropic",
      models: { mode: "allow", ids: ["totally-retired-model"] },
    })
    const currentIds = buildCatalogProviderModels({ endpoint: "anthropic" }).models.map(m => m.id)

    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "auth_profile_refresh_models",
      arguments: { id: "anthropic-sub" },
    })
    await cleanup()

    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { profile: { models?: { mode: string; ids: string[] } }; added: string[]; removed: string[] }

    expect(payload.profile.models?.mode).toBe("allow")
    expect(new Set(payload.profile.models?.ids)).toEqual(new Set(currentIds))
    expect(payload.removed).toContain("totally-retired-model")
  })

  it("rejects an unknown profile id with a clear message", async () => {
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "auth_profile_refresh_models",
      arguments: { id: "does-not-exist" },
    })
    await cleanup()

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text
    expect(text).toMatch(/no profile with id "does-not-exist"/)
  })
})
