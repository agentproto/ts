/**
 * The Claude Desktop approval card: the model-visible `approval_pending`
 * widget tool and the `ui://agentproto/approval/pending` list resource, both
 * served by `buildApprovalCardsServer` on `?surface=approval-cards` only.
 *
 * Same harness as `approvals-card-surface.test.ts` (real `startHttpServer`
 * and `handleMcp`, real MCP client), but the factory branches through the
 * production `buildApprovalCardsServer` so the gate under test is the shipped one.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { registerApprovalTools } from "../approvals/tools.js"
import { buildApprovalCardsServer } from "../approvals/card-surface.js"
import { renderPendingApprovalsHtml } from "../approvals/card.js"
import { runCardPage } from "./helpers/approvals-card-page.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const PENDING_URI = "ui://agentproto/approval/pending"

let home: string
let engine: ApprovalsEngine

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-pending-card-"))
  engine = createApprovalsEngine({ homeDir: home, sessionEvents: createSessionEventBus() })
})

afterEach(() => {
  engine.dispose()
  rmSync(home, { recursive: true, force: true })
})

async function mcpServerFactory(
  _denyTools?: ReadonlySet<string>,
  callerSessionId?: string,
  _origin?: string,
  _deferred?: boolean,
  _allowTools?: ReadonlySet<string>,
  surface?: string,
) {
  const cards = buildApprovalCardsServer(engine, { surface, callerSessionId }, { name: "cards", version: "0" })
  if (cards) return cards
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  server.registerTool("root_probe", { description: "stands in for the daemon's root tools" }, async () => ({
    content: [{ type: "text" as const, text: "root" }],
  }))
  registerApprovalTools(server, { engine, ...(callerSessionId ? { callerSessionId } : {}) })
  return server
}

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

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return { start() {}, stop() {}, async fireNow() {} }
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
  })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
  }
}

async function connect(base: string, query = ""): Promise<Client> {
  const client = new Client({ name: "approvals-pending-card-test", version: "0.0.1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp${query}`)))
  return client
}

function request(title: string, requester: { sessionId: string } | { operator: true } = { sessionId: "sess_abc" }): string {
  return engine.request({ kind: "send", title, preview: { to: "ana@example.com" }, payload: { title } }, requester).id
}

async function readHtml(client: Client, uri: string): Promise<string> {
  const read = await client.readResource({ uri })
  const content = read.contents[0]
  if (!content || !("text" in content)) throw new Error("resource read returned no text content")
  return content.text
}

interface ListedApproval {
  id: string
  title: string
  kind: string
  requestedBy: string
  status?: string
  expiresAt?: string
  ticket?: string
}

async function listCards(client: Client, approvalId?: string): Promise<ListedApproval[]> {
  const result = (await client.callTool({
    name: "approval_card_list",
    arguments: approvalId ? { approvalId } : {},
  })) as { structuredContent?: { approvals: ListedApproval[] }; isError?: boolean }
  expect(result.isError).toBeFalsy()
  return result.structuredContent?.approvals ?? []
}

async function decide(client: Client, approvalId: string, decision: "approve" | "deny", ticket: string) {
  return (await client.callTool({
    name: "approval_card_decide",
    arguments: { approvalId, decision, ticket },
  })) as { isError?: boolean }
}

describe("approval_pending is mounted on the cards surface only", () => {
  it("root /mcp: no approval_pending tool, no pending resource", async () => {
    await withServer(async base => {
      request("Send")
      const client = await connect(base)
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).not.toContain("approval_pending")
      expect(tools.map(t => t.name)).not.toContain("approval_card_list")
      await expect(client.callTool({ name: "approval_card_list", arguments: {} })).resolves.toMatchObject({ isError: true })
      const { resources } = await client.listResources().catch(() => ({ resources: [] }))
      expect(resources.map(r => r.uri)).not.toContain(PENDING_URI)
      await expect(client.readResource({ uri: PENDING_URI })).rejects.toThrow()
      await client.close()
    })
  })

  it("a ?callerSessionId=... connection: same refusal", async () => {
    await withServer(async base => {
      request("Send")
      const client = await connect(base, "?callerSessionId=sess_x")
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).not.toContain("approval_pending")
      expect(tools.map(t => t.name)).not.toContain("approval_card_list")
      await expect(client.callTool({ name: "approval_card_list", arguments: {} })).resolves.toMatchObject({ isError: true })
      await expect(client.readResource({ uri: PENDING_URI })).rejects.toThrow()
      await client.close()
    })
  })

  it("?surface=approval-cards: the tool and the resource are there", async () => {
    await withServer(async base => {
      const client = await connect(base, "?surface=approval-cards")
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toContain("approval_pending")
      const { resources } = await client.listResources()
      expect(resources.map(r => r.uri)).toContain(PENDING_URI)
      await client.close()
    })
  })
})

describe("the approval-cards surface is cards-only", () => {
  it("tools/list is exactly approval_card_decide, approval_card_list and approval_pending", async () => {
    await withServer(async base => {
      request("Send")
      const client = await connect(base, "?surface=approval-cards")
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name).sort()).toEqual(["approval_card_decide", "approval_card_list", "approval_pending"])
      await client.close()
    })
  })

  it("resources/list has only approval URIs: the pending list plus one card per pending approval", async () => {
    await withServer(async base => {
      const a = request("Send")
      const b = request("Pay")
      const client = await connect(base, "?surface=approval-cards")
      const { resources } = await client.listResources()
      const uris = resources.map(r => r.uri).sort()
      expect(uris).toEqual(
        [PENDING_URI, `ui://agentproto/approval/${a}`, `ui://agentproto/approval/${b}`].sort(),
      )
      expect(uris.every(uri => uri.startsWith("ui://agentproto/approval/"))).toBe(true)
      await client.close()
    })
  })

  it("root /mcp is unchanged: its tools stay, the cards stay off", async () => {
    await withServer(async base => {
      request("Send")
      const client = await connect(base)
      const { tools } = await client.listTools()
      const names = tools.map(t => t.name)
      expect(names).toContain("root_probe")
      expect(names).toContain("approval_request")
      expect(names).not.toContain("approval_card_decide")
      expect(names).not.toContain("approval_pending")
      expect(names).not.toContain("approval_card_list")
      await client.close()
    })
  })

  it("builds nothing for another surface or for an agent session", () => {
    const info = { name: "cards", version: "0" }
    expect(buildApprovalCardsServer(engine, {}, info)).toBeUndefined()
    expect(buildApprovalCardsServer(engine, { surface: "other" }, info)).toBeUndefined()
    expect(buildApprovalCardsServer(engine, { surface: "approval-cards", callerSessionId: "sess_x" }, info)).toBeUndefined()
  })
})

describe("approval_pending tool", () => {
  it("carries the widget link on its DEFINITION and is visible to the model", async () => {
    await withServer(async base => {
      const client = await connect(base, "?surface=approval-cards")
      const { tools } = await client.listTools()
      const pending = tools.find(t => t.name === "approval_pending")
      expect(pending?._meta).toMatchObject({ ui: { resourceUri: PENDING_URI, visibility: ["model", "app"] } })
      expect(pending?.inputSchema.required ?? []).toEqual([])

      // The decide tool stays out of the model's reach.
      const decide = tools.find(t => t.name === "approval_card_decide")
      expect(decide?._meta).toMatchObject({ ui: { visibility: ["app"] } })
      const list = tools.find(t => t.name === "approval_card_list")
      expect(list?._meta).toMatchObject({ ui: { visibility: ["app"] } })
      expect(list?.inputSchema.required ?? []).toEqual([])
      await client.close()
    })
  })

  it("lists the pending approvals for the model and never carries a ticket", async () => {
    await withServer(async base => {
      const a = request("Send the Q3 report")
      const b = request("Pay invoice 42", { operator: true })
      const decided = request("Already done")
      const { ticket } = engine.mintCardTicket(decided)
      await engine.decideByCard(decided, "approve", ticket, { ipAddress: "t", userAgent: "t" })

      const client = await connect(base, "?surface=approval-cards")
      const result = (await client.callTool({ name: "approval_pending", arguments: {} })) as {
        content: Array<{ type: string; text: string }>
        structuredContent?: { count: number; pending: Array<Record<string, unknown>> }
        isError?: boolean
      }
      expect(result.isError).toBeFalsy()
      const items = result.structuredContent?.pending ?? []
      expect(result.structuredContent?.count).toBe(2)
      expect(items.map(i => i.id).sort()).toEqual([a, b].sort())
      expect(items.find(i => i.id === a)).toMatchObject({ title: "Send the Q3 report", kind: "send", requestedBy: "sess_abc" })
      expect(items.find(i => i.id === b)).toMatchObject({ title: "Pay invoice 42", requestedBy: "operator" })

      const text = result.content.map(c => c.text).join("\n")
      expect(text).toContain("Send the Q3 report")
      expect(text.toLowerCase()).not.toContain("ticket")
      expect(JSON.stringify(result).toLowerCase()).not.toContain("ticket")
      await client.close()
    })
  })

  it("an empty list is count 0, not an error", async () => {
    await withServer(async base => {
      const client = await connect(base, "?surface=approval-cards")
      const result = (await client.callTool({ name: "approval_pending", arguments: {} })) as {
        structuredContent?: { count: number; pending: unknown[] }
        isError?: boolean
      }
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toEqual({ count: 0, pending: [] })
      await client.close()
    })
  })
})

describe("approval_card_list tool", () => {
  it("lists the pending approvals with a fresh ticket each, and the approval's own expiry only", async () => {
    await withServer(async base => {
      const a = request("Send the Q3 report")
      const b = request("Pay invoice 42", { operator: true })
      const decided = request("Already done")
      const { ticket } = engine.mintCardTicket(decided)
      await engine.decideByCard(decided, "approve", ticket, { ipAddress: "t", userAgent: "t" })

      const client = await connect(base, "?surface=approval-cards")
      const items = await listCards(client)
      expect(items.map(i => i.id).sort()).toEqual([a, b].sort())
      expect(items.find(i => i.id === a)).toMatchObject({ title: "Send the Q3 report", kind: "send", requestedBy: "sess_abc" })
      expect(items.find(i => i.id === b)).toMatchObject({ title: "Pay invoice 42", requestedBy: "operator" })
      for (const item of items) {
        expect(item.ticket).toBeTruthy()
        expect(item.expiresAt).toBeUndefined()
      }
      expect(items[0]!.ticket).not.toBe(items[1]!.ticket)
      await client.close()
    })
  })

  it("each call mints a new ticket, and the earlier one stops working", async () => {
    await withServer(async base => {
      const a = request("Send")
      const client = await connect(base, "?surface=approval-cards")
      const first = (await listCards(client))[0]!
      const second = (await listCards(client))[0]!
      expect(first.id).toBe(a)
      expect(first.ticket).not.toBe(second.ticket)
      expect((await decide(client, a, "approve", first.ticket!)).isError).toBe(true)
      expect(engine.get(a)?.status).toBe("pending")
      // a refused attempt burns the stored ticket, so the page asks again
      const third = (await listCards(client, a))[0]!
      expect(third.ticket).not.toBe(second.ticket)
      expect((await decide(client, a, "approve", third.ticket!)).isError).toBeFalsy()
      expect(engine.get(a)?.status).toBe("approved")
      await client.close()
    })
  })

  it("a ticket decides only its own approval", async () => {
    await withServer(async base => {
      const a = request("Send the Q3 report")
      const b = request("Pay invoice 42")
      const client = await connect(base, "?surface=approval-cards")

      const both = await listCards(client)
      const ticketA = both.find(c => c.id === a)!.ticket!
      expect((await decide(client, b, "approve", ticketA)).isError).toBe(true)
      expect(engine.get(b)?.status).toBe("pending")

      const freshA = (await listCards(client, a))[0]!.ticket!
      expect((await decide(client, a, "approve", freshA)).isError).toBeFalsy()
      expect(engine.get(a)?.status).toBe("approved")
      expect(engine.get(b)?.status).toBe("pending")

      const freshB = (await listCards(client, b))[0]!.ticket!
      expect((await decide(client, b, "deny", freshB)).isError).toBeFalsy()
      expect(engine.get(b)?.status).toBe("denied")
      await client.close()
    })
  })

  it("an empty list is an empty array, not an error", async () => {
    await withServer(async base => {
      const client = await connect(base, "?surface=approval-cards")
      expect(await listCards(client)).toEqual([])
      await client.close()
    })
  })

  it("a decided approval is returned with its final status and no ticket", async () => {
    await withServer(async base => {
      const id = request("Done")
      const { ticket } = engine.mintCardTicket(id)
      await engine.decideByCard(id, "deny", ticket, { ipAddress: "t", userAgent: "t" })
      const client = await connect(base, "?surface=approval-cards")
      const [item] = await listCards(client, id)
      expect(item).toMatchObject({ id, status: "denied" })
      expect(item?.ticket).toBeUndefined()
      await client.close()
    })
  })
})

describe("the card resources are templates", () => {
  it("the pending resource holds no approval data and no ticket, and reading it mints nothing", async () => {
    await withServer(async base => {
      const a = request("Send the Q3 report")
      const before = engine.mintCardTicket(a).ticket
      const client = await connect(base, "?surface=approval-cards")
      const html = await readHtml(client, PENDING_URI)
      expect(html).not.toContain("Send the Q3 report")
      expect(html).not.toContain("var TICKET")
      expect(html).not.toContain(before)
      expect(html).toContain("approval_card_list")
      expect(html).toContain("ui/notifications/size-changed")
      // the read minted nothing: the ticket from before still decides
      expect((await decide(client, a, "approve", before)).isError).toBeFalsy()
      await client.close()
    })
  })

  it("the per-approval resource is the same template, differing only by the id", async () => {
    await withServer(async base => {
      const a = request("Send the Q3 report")
      request("Pay invoice 42")
      const client = await connect(base, "?surface=approval-cards")
      const pending = await readHtml(client, PENDING_URI)
      const single = await readHtml(client, `ui://agentproto/approval/${a}`)
      expect(single).not.toContain("Send the Q3 report")
      expect(single.replaceAll(JSON.stringify(a), "null")).toBe(pending)
      await client.close()
    })
  })

  it("a cached template page shows the approvals that exist now, through the real surface", async () => {
    await withServer(async base => {
      const client = await connect(base, "?surface=approval-cards")
      const cached = await readHtml(client, PENDING_URI)
      const a = request("Send the Q3 report")
      const page = runCardPage(cached, {
        callTool: (name, args) => client.callTool({ name, arguments: args }),
      })
      await page.flush()
      expect(page.cards().map(c => page.titleOf(c))).toEqual(["Send the Q3 report"])

      const board = page.buttons(page.cards()[0]!)
      board.approve.click()
      await page.flush()
      expect(engine.get(a)?.status).toBe("approved")
      expect(page.note.textContent).toBe("Nothing to approve")
      await client.close()
    })
  })

  it("the per-approval card decides through the bridge via approval_card_list + approval_card_decide", async () => {
    await withServer(async base => {
      const a = request("Send the Q3 report")
      request("Pay invoice 42")
      const client = await connect(base, "?surface=approval-cards")
      const html = await readHtml(client, `ui://agentproto/approval/${a}`)
      const page = runCardPage(html, { callTool: (name, args) => client.callTool({ name, arguments: args }) })
      await page.flush()
      expect(page.cards()).toHaveLength(1)
      page.buttons(page.cards()[0]!).deny.click()
      await page.flush()
      expect(page.calls().map(m => m.params?.["name"])).toEqual(["approval_card_list", "approval_card_decide", "approval_card_list"])
      expect(engine.get(a)?.status).toBe("denied")
      expect(page.statusOf(page.cards()[0]!)).toBe("Refused")
      await client.close()
    })
  })

  it("with nothing pending the template shows the empty state once it has loaded", async () => {
    const html = renderPendingApprovalsHtml()
    expect(html).toContain("Nothing to approve")
    expect(html).not.toContain('class="card"')
  })
})
