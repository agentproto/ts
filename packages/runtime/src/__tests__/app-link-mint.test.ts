/**
 * `app_link_mint` takes an optional `sessionId` plus a generic `claims` map
 * (AIP-53 link tokens about an approval or a dossier, not only a session),
 * and `authorizeAppLink` hands the non-reserved claims back.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerAppTools } from "../app-tools.js"
import { createAppRegistry } from "../app-registry.js"
import { createSessionsRegistry } from "../sessions.js"
import { authorizeAppLink } from "../app-link-auth.js"
import { verifyAppLinkSessionToken, verifyAppLinkToken } from "../app-link-token.js"
import type { TelegramBotCredsStore } from "../telegram-bot-creds.js"
import { FAKE_BOT_TOKEN, signInitData, buildInitDataFields } from "./helpers/telegram-init-data-fixture.js"

const APP_ID = "@test/approvals"

const telegramCreds: TelegramBotCredsStore = {
  read: async alias => (alias === "default" ? { token: FAKE_BOT_TOKEN } : null),
  write: async () => {},
  exists: async alias => alias === "default",
}

async function setup() {
  const appRegistry = createAppRegistry()
  appRegistry.upsertApp({
    appId: APP_ID,
    dir: "/tmp/approvals",
    agents: [],
    workflows: [],
    unvalidatedAgentTools: [],
    ui: {
      path: "/tmp/approvals/ui.html",
      tools: ["approval_probe"],
      toolScope: { approval_probe: { approvalId: "$link.approvalId" } },
    },
  })
  const server = new McpServer({ name: "link-mint-test", version: "0.0.0" })
  registerAppTools(server, {
    registry: createSessionsRegistry({ persist: false }),
    appRegistry,
    listRegisteredToolIds: async () => [],
    resolveAgentAdapter: (async () => {
      throw new Error("not used")
    }) as never,
    waitForSessionTerminal: async () => {},
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "link-mint-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  const mint = (args: Record<string, unknown>) =>
    client.callTool({ name: "app_link_mint", arguments: { appId: APP_ID, telegramUserId: "42", ...args } })
  return { mint }
}

function text(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  return content?.find(c => c.type === "text")?.text ?? ""
}
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true

describe("app_link_mint: optional sessionId and generic claims", () => {
  let mint: Awaited<ReturnType<typeof setup>>["mint"]
  beforeEach(async () => {
    ;({ mint } = await setup())
  })

  it("mints a claims-only link whose exchange yields a session token and the claims in the body", async () => {
    const minted = await mint({ claims: { approvalId: "a1" } })
    expect(isError(minted)).toBe(false)
    const { linkToken } = JSON.parse(text(minted)) as { linkToken: string }

    const verified = verifyAppLinkToken(linkToken)
    expect(verified.ok).toBe(true)
    if (verified.ok) {
      expect(verified.payload.claims.approvalId).toBe("a1")
      expect(verified.payload.claims.sessionId).toBeUndefined()
      expect(verified.payload.pendingTelegramAuth).toBe(true)
    }

    const exchanged = await authorizeAppLink({
      linkToken,
      initData: signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN),
      telegramCreds,
    })
    expect(exchanged.ok).toBe(true)
    if (!exchanged.ok) throw new Error("unreachable")
    expect(exchanged.sessionId).toBeUndefined()
    expect(exchanged.claims).toEqual({ approvalId: "a1" })
    const session = verifyAppLinkSessionToken(exchanged.sessionToken)
    expect(session.ok).toBe(true)
    if (session.ok) {
      expect(session.payload.claims.approvalId).toBe("a1")
      expect(session.payload.claims.telegramUserId).toBe("42")
    }
  })

  it("a sessionId plus claims keeps both, and the exchange never returns the daemon-owned claims", async () => {
    const minted = await mint({ sessionId: "sess_1", claims: { approvalId: "a1" }, botAlias: "default", sessionTtlMs: 60_000 })
    const { linkToken } = JSON.parse(text(minted)) as { linkToken: string }
    const exchanged = await authorizeAppLink({
      linkToken,
      initData: signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN),
      telegramCreds,
    })
    expect(exchanged.ok).toBe(true)
    if (!exchanged.ok) throw new Error("unreachable")
    expect(exchanged.sessionId).toBe("sess_1")
    expect(exchanged.claims).toEqual({ sessionId: "sess_1", approvalId: "a1" })
  })

  it("a session-only mint is unchanged", async () => {
    const minted = await mint({ sessionId: "sess_1" })
    expect(isError(minted)).toBe(false)
    const body = JSON.parse(text(minted)) as { sessionId: string; linkToken: string }
    expect(body.sessionId).toBe("sess_1")
  })

  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ["neither a sessionId nor claims", {}, /sessionId.*claims/],
    ["an empty claims map and no sessionId", { claims: {} }, /sessionId.*claims/],
    ["a reserved claim name", { claims: { telegramUserId: "7" } }, /reserved/],
    ["each other reserved name", { claims: { appId: "x" } }, /reserved/],
    ["a bad claim name", { claims: { "1bad": "x" } }, /invalid/],
    ["a claim name with a dash", { claims: { "a-b": "x" } }, /invalid/],
    ["a claim name over 32 characters", { claims: { [`a${"b".repeat(32)}`]: "x" } }, /invalid/],
    ["an empty claim value", { claims: { approvalId: "" } }, /1 to 200/],
    ["a claim value over 200 characters", { claims: { approvalId: "x".repeat(201) } }, /1 to 200/],
    [
      "nine claims",
      { claims: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, "v"])) },
      /at most 8/,
    ],
    ["sessionId repeated inside claims", { sessionId: "sess_1", claims: { sessionId: "sess_2" } }, /sessionId/],
    ["sessionId only inside claims", { claims: { sessionId: "sess_2" } }, /sessionId/],
  ]
  for (const [label, args, pattern] of refusals) {
    it(`refuses ${label}`, async () => {
      const result = await mint(args)
      expect(isError(result)).toBe(true)
      expect(text(result)).toMatch(pattern)
    })
  }

  it("accepts the boundary values: 8 claims, a 200 character value, a 32 character name", async () => {
    const claims = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`c${i}`, "v"]))
    Object.assign(claims, { [`a${"b".repeat(31)}`]: "x".repeat(200) })
    expect(isError(await mint({ claims }))).toBe(false)
  })
})
