/**
 * The Claude Desktop approval card: the model-visible `approval_pending`
 * widget tool and the `ui://agentproto/approval/pending` list resource, both
 * mounted by `mountApprovalCardSurface` on `?surface=approval-cards` only.
 *
 * Same harness as `approvals-card-surface.test.ts` (real `startHttpServer`
 * and `handleMcp`, real MCP client), but the factory calls the production
 * `mountApprovalCardSurface` so the gate under test is the shipped one.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import vm from "node:vm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { registerApprovalTools } from "../approvals/tools.js"
import { mountApprovalCardSurface } from "../approvals/card-surface.js"
import { renderPendingApprovalsHtml } from "../approvals/card.js"
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
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerApprovalTools(server, { engine, ...(callerSessionId ? { callerSessionId } : {}) })
  mountApprovalCardSurface(server, engine, { surface, callerSessionId })
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

/** Ticket and approval id of every card on a pending page. */
function cardsOf(html: string): Array<{ id: string; ticket: string }> {
  const match = html.match(/var CARDS = (\[.*?\]);/)
  if (!match) throw new Error("no CARDS table in the page")
  return JSON.parse(match[1]!) as Array<{ id: string; ticket: string }>
}

describe("approval_pending is mounted on the cards surface only", () => {
  it("root /mcp: no approval_pending tool, no pending resource", async () => {
    await withServer(async base => {
      request("Send")
      const client = await connect(base)
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).not.toContain("approval_pending")
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

describe("the pending resource", () => {
  it("renders one card per pending approval, each with its own ticket that decides only its own approval", async () => {
    await withServer(async base => {
      const a = request("Send the Q3 report")
      const b = request("Pay invoice 42")

      const client = await connect(base, "?surface=approval-cards")
      const html = await readHtml(client, PENDING_URI)
      expect(html).toContain("Send the Q3 report")
      expect(html).toContain("Pay invoice 42")
      expect((html.match(/class="card"/g) ?? []).length).toBe(2)
      expect(html).toContain("ui/notifications/size-changed")

      const cards = cardsOf(html)
      expect(cards.map(c => c.id).sort()).toEqual([a, b].sort())
      const [cardA, cardB] = [cards.find(c => c.id === a)!, cards.find(c => c.id === b)!]
      expect(cardA.ticket).not.toBe(cardB.ticket)

      // A's ticket does not decide B ...
      const cross = (await client.callTool({
        name: "approval_card_decide",
        arguments: { approvalId: b, decision: "approve", ticket: cardA.ticket },
      })) as { isError?: boolean }
      expect(cross.isError).toBe(true)
      expect(engine.get(b)?.status).toBe("pending")

      // ... and B's own ticket was burned by that attempt only for B's id, so
      // re-read to get a fresh pair, then each ticket decides its own.
      const fresh = cardsOf(await readHtml(client, PENDING_URI))
      const freshA = fresh.find(c => c.id === a)!
      const freshB = fresh.find(c => c.id === b)!
      const okA = (await client.callTool({
        name: "approval_card_decide",
        arguments: { approvalId: a, decision: "approve", ticket: freshA.ticket },
      })) as { isError?: boolean }
      expect(okA.isError).toBeFalsy()
      expect(engine.get(a)?.status).toBe("approved")
      expect(engine.get(b)?.status).toBe("pending")

      const okB = (await client.callTool({
        name: "approval_card_decide",
        arguments: { approvalId: b, decision: "deny", ticket: freshB.ticket },
      })) as { isError?: boolean }
      expect(okB.isError).toBeFalsy()
      expect(engine.get(b)?.status).toBe("denied")
      await client.close()
    })
  })

  it("each read mints fresh tickets (an earlier page's tickets stop working)", async () => {
    await withServer(async base => {
      const a = request("Send")
      const client = await connect(base, "?surface=approval-cards")
      const first = cardsOf(await readHtml(client, PENDING_URI))[0]!
      const second = cardsOf(await readHtml(client, PENDING_URI))[0]!
      expect(first.ticket).not.toBe(second.ticket)
      const stale = (await client.callTool({
        name: "approval_card_decide",
        arguments: { approvalId: a, decision: "approve", ticket: first.ticket },
      })) as { isError?: boolean }
      expect(stale.isError).toBe(true)
      expect(engine.get(a)?.status).toBe("pending")
      await client.close()
    })
  })

  it("with nothing pending it is the empty state", () => {
    const html = renderPendingApprovalsHtml(engine)
    expect(html).toContain("Nothing to approve")
    expect(html).not.toContain("approval_card_decide")
    expect(html).not.toContain("class=\"card\"")
  })
})

describe("the pending page script", () => {
  interface FakeEl {
    textContent: string
    disabled: boolean
    hidden: boolean
    removed: boolean
    attrs: Record<string, string>
    listeners: Record<string, () => void>
    getAttribute(name: string): string | null
    addEventListener(type: string, fn: () => void): void
    remove(): void
  }
  const fakeEl = (attrs: Record<string, string> = {}): FakeEl => {
    const el: FakeEl = {
      textContent: "",
      disabled: false,
      hidden: false,
      removed: false,
      attrs,
      listeners: {},
      getAttribute: name => el.attrs[name] ?? null,
      addEventListener: (type, fn) => {
        el.listeners[type] = fn
      },
      remove: () => {
        el.removed = true
      },
    }
    return el
  }

  function runPage(html: string, count: number) {
    const posted: Array<{ id?: number; method?: string; params?: Record<string, unknown> }> = []
    const els: Record<string, FakeEl> = { empty: fakeEl() }
    for (let i = 0; i < count; i++) {
      for (const name of ["card", "approve", "deny", "status", "expiry"]) els[`${name}-${i}`] = fakeEl()
    }
    let onMessage: (evt: { data: unknown; source?: unknown }) => void = () => {}
    const parent = { postMessage: (msg: (typeof posted)[number]) => void posted.push(msg) }
    vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
      window: {
        parent,
        addEventListener: (type: string, fn: typeof onMessage) => {
          if (type === "message") onMessage = fn
        },
      },
      document: {
        documentElement: { setAttribute() {}, style: { setProperty() {}, removeProperty() {} } },
        body: { getBoundingClientRect: () => ({ height: 100 }) },
        getElementById: (id: string) => els[id],
      },
      ResizeObserver: class {
        observe(): void {}
      },
      setInterval: () => 1,
      clearInterval: () => {},
    })
    const reply = (id: number, result: unknown) => onMessage({ data: { jsonrpc: "2.0", id, result }, source: parent })
    const flush = () => new Promise<void>(resolve => setImmediate(resolve))
    return { posted, els, reply, flush }
  }

  it("Approve calls approval_card_decide with that card's id and ticket, then removes only that card", async () => {
    const a = request("First")
    const b = request("Second")
    const html = renderPendingApprovalsHtml(engine)
    const cards = cardsOf(html)
    const page = runPage(html, cards.length)
    const indexOfB = cards.findIndex(c => c.id === b)

    page.els[`approve-${indexOfB}`]!.listeners.click!()
    const call = page.posted.find(m => m.method === "tools/call")
    expect(call?.params).toEqual({
      name: "approval_card_decide",
      arguments: { approvalId: b, decision: "approve", ticket: cards[indexOfB]!.ticket },
    })
    expect(page.els[`approve-${indexOfB}`]!.disabled).toBe(true)

    page.reply(call!.id!, { content: [] })
    await page.flush()
    expect(page.els[`card-${indexOfB}`]!.removed).toBe(true)
    const indexOfA = cards.findIndex(c => c.id === a)
    expect(page.els[`card-${indexOfA}`]!.removed).toBe(false)
    expect(page.els.empty!.hidden).toBe(false)
  })

  it("shows the empty state once the last card is gone, and keeps a failed card with a message", async () => {
    request("Only")
    const html = renderPendingApprovalsHtml(engine)
    const page = runPage(html, 1)

    page.els["deny-0"]!.listeners.click!()
    const first = page.posted.find(m => m.method === "tools/call")!
    page.reply(first.id!, { isError: true, content: [{ type: "text", text: "ticket_invalid: used" }] })
    await page.flush()
    expect(page.els["card-0"]!.removed).toBe(false)
    expect(page.els["status-0"]!.textContent).toBe("This card has expired. Open it again to decide.")
    expect(page.els["deny-0"]!.disabled).toBe(false)

    page.els["deny-0"]!.listeners.click!()
    const second = page.posted.filter(m => m.method === "tools/call")[1]!
    page.reply(second.id!, { content: [] })
    await page.flush()
    expect(page.els["card-0"]!.removed).toBe(true)
    expect(page.els.empty!.hidden).toBe(false)
  })
})
