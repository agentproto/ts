/**
 * Thin wrapper tests for the `auth_profile_update` MCP tool
 * (auth-profile-tools.ts). The patch semantics themselves (absent leaves,
 * null clears, blank/overlong label rejected, invalid costBudget rejected)
 * are exhaustively covered in `@agentproto/auth`'s `profile-provision.test.ts`
 * — these only assert this wrapper's happy path, its key-identity
 * enrichment / full-vs-compact projection, and its unknown-profile error
 * shape.
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

// authProfilesPath() resolves under os.homedir() → $HOME on POSIX (same
// isolation profile-store.test.ts uses) — a temp HOME keeps this off the
// real ~/.agentproto/auth-profiles.json.
let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-auth-profile-update-tool-"))
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

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

describe("auth_profile_update", () => {
  it("sets label and costBudget, returning the full row with key identity", async () => {
    // No credentialRef — describeProfileKey must not touch the OS keychain
    // for this test; a source-backed profile reports "self-refreshing".
    await addAuthProfile({
      id: "anthropic-sub",
      endpoint: "anthropic",
      method: "oauth-bearer",
      source: "claude-code-oauth",
    })

    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "auth_profile_update",
      arguments: {
        id: "anthropic-sub",
        label: "Work Anthropic",
        costBudget: { maxCostUsd: 50, window: "7d", scope: "profile" },
      },
    })
    await cleanup()

    expect(result.isError).toBeFalsy()
    const payload = parse(result)
    expect(payload.profile).toMatchObject({
      id: "anthropic-sub",
      label: "Work Anthropic",
      costBudget: { maxCostUsd: 50, window: "7d", scope: "profile" },
      keyStatus: "self-refreshing",
    })
    // Never touches source/credentialRef, and never the secret.
    expect(payload.profile.source).toBe("claude-code-oauth")
    expect(payload.profile.credentialRef).toBeUndefined()
  })

  it("full: false drops costBudget from the response (compact projection)", async () => {
    await addAuthProfile({ id: "p", endpoint: "openrouter", method: "api-key" })

    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "auth_profile_update",
      arguments: {
        id: "p",
        costBudget: { maxCostUsd: 10, window: "5h", scope: "session" },
        full: false,
      },
    })
    await cleanup()

    const payload = parse(result)
    expect(payload.profile.costBudget).toBeUndefined()
    expect(payload.profile.keyStatus).toBe("self-refreshing")
  })

  it("clears a field with null", async () => {
    await addAuthProfile({
      id: "p",
      endpoint: "openrouter",
      method: "api-key",
      label: "old label",
    })

    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "auth_profile_update",
      arguments: { id: "p", label: null },
    })
    await cleanup()

    const payload = parse(result)
    expect(payload.profile.label).toBeUndefined()
  })

  it("rejects an unknown profile id with a clear message", async () => {
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "auth_profile_update",
      arguments: { id: "does-not-exist", label: "x" },
    })
    await cleanup()

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text
    expect(text).toMatch(/no profile with id "does-not-exist"/)
  })

  it("rejects an empty patch", async () => {
    await addAuthProfile({ id: "p", endpoint: "openrouter", method: "api-key" })

    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "auth_profile_update",
      arguments: { id: "p" },
    })
    await cleanup()

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text
    expect(text).toMatch(/at least one of label or costBudget/)
  })
})
