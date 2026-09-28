/**
 * Approvals over MCP: the model-visible surface (`approval_request` /
 * `approval_get` / `approval_wait` / `approval_consume`), the app-only
 * `approval_card_decide` (visibility gate + real decide-by-ticket flow via
 * `resources/read`), and the ticket-secrecy invariant — the raw ticket
 * string must never appear in any tool call's serialized result.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerUiResource } from "@agentproto/mcp-server"

import { createSessionEventBus } from "../session-event-bus.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { registerApprovalTools } from "../approvals/tools.js"
import { registerApprovalCardDecideTool } from "../approvals/card-tool.js"
import { approvalCardResourceUri, renderApprovalCardHtml } from "../approvals/card.js"

let home: string
let engine: ApprovalsEngine
let client: Client

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-mcp-"))
  const bus = createSessionEventBus()
  engine = createApprovalsEngine({
    homeDir: home,
    sessionEvents: bus,
    webOrigins: ["https://web.example.invalid"],
  })
})

afterEach(async () => {
  await client?.close()
  engine.dispose()
  rmSync(home, { recursive: true, force: true })
})

/** Wire a server exactly like `index.ts`'s `mcpServerFactory`: the
 *  model-visible tools, the app-only card-decide tool, and a `ui://`
 *  resource for every currently-pending approval. */
async function connectClient(callerSessionId?: string): Promise<Client> {
  const server = new McpServer({ name: "approvals-mcp-test", version: "0.0.0" })
  registerApprovalTools(server, { engine, ...(callerSessionId ? { callerSessionId } : {}) })
  registerApprovalCardDecideTool(server, engine)
  for (const pending of engine.list({ status: "pending" })) {
    registerUiResource(server, {
      name: `approval-${pending.id}`,
      uri: approvalCardResourceUri(pending.id),
      html: () => renderApprovalCardHtml(engine, pending.id),
    })
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const c = new Client({ name: "approvals-mcp-test-client", version: "0.0.0" })
  await c.connect(clientTransport)
  return c
}

function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text) as Record<string, unknown>
}

describe("Approvals MCP: model-visible tools", () => {
  it("approval_request -> approval_get -> approval_consume, end to end (operator caller)", async () => {
    client = await connectClient()

    const requested = parse(
      await client.callTool({
        name: "approval_request",
        arguments: {
          kind: "send",
          title: "Send invoice",
          preview: { to: "a@b.invalid" },
          payload: { to: "a@b.invalid", amount: 10 },
        },
      }),
    )
    expect(requested.status).toBe("pending")
    const id = requested.id as string

    const got = parse(await client.callTool({ name: "approval_get", arguments: { id } }))
    expect(got.id).toBe(id)

    // No model-callable tool can decide it — approve directly on the
    // engine (standing in for a human channel) before consuming.
    await engine.decideWeb(id, "approve", { ipAddress: "1.2.3.4", userAgent: "test" })

    const consumed = parse(
      await client.callTool({
        name: "approval_consume",
        arguments: { id, payload: { to: "a@b.invalid", amount: 10 } },
      }),
    )
    expect(consumed.status).toBe("consumed")
  })

  it("a session caller (callerSessionId) can only consume its own request", async () => {
    client = await connectClient("sess_A")
    const requested = parse(
      await client.callTool({
        name: "approval_request",
        arguments: { kind: "send", title: "Send", preview: {}, payload: { x: 1 } },
      }),
    )
    const id = requested.id as string
    await engine.decideWeb(id, "approve", { ipAddress: "1.2.3.4", userAgent: "test" })

    // A different session tries to consume.
    const other = await connectClient("sess_B")
    const denied = parse(await other.callTool({ name: "approval_consume", arguments: { id, payload: { x: 1 } } }))
    expect(denied.error).toBe("not_requester")
    await other.close()

    const ok = parse(await client.callTool({ name: "approval_consume", arguments: { id, payload: { x: 1 } } }))
    expect(ok.status).toBe("consumed")
  })

  it("approval_wait resolves once a human decides", async () => {
    client = await connectClient()
    const requested = parse(
      await client.callTool({
        name: "approval_request",
        arguments: { kind: "send", title: "Send", preview: {}, payload: { x: 1 } },
      }),
    )
    const id = requested.id as string

    const waitPromise = client.callTool({ name: "approval_wait", arguments: { id, timeoutMs: 5000 } })
    await new Promise(r => setTimeout(r, 20))
    await engine.decideWeb(id, "deny", { ipAddress: "1.2.3.4", userAgent: "test" })
    const waited = parse(await waitPromise)
    expect(waited.status).toBe("denied")
  })

  it("approval_get on an unknown id answers a structured error, not a throw", async () => {
    client = await connectClient()
    const res = parse(await client.callTool({ name: "approval_get", arguments: { id: "apr_ghost" } }))
    expect(res.error).toBe("approval_not_found")
  })
})

describe("Approvals MCP: nothing model-visible can decide", () => {
  it("approval_card_decide's definition carries _meta.ui.visibility: ['app']", async () => {
    client = await connectClient()
    const { tools } = await client.listTools()
    const cardDecide = tools.find(t => t.name === "approval_card_decide")
    expect(cardDecide).toBeDefined()
    expect((cardDecide?._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility).toEqual(["app"])
  })

  it("filtering the tool list the way a host does for its model (drop visibility lacking 'model') leaves no way to decide", async () => {
    client = await connectClient()
    const { tools } = await client.listTools()
    const modelVisible = tools.filter(t => {
      const visibility = (t._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility
      // No declared `_meta.ui` at all ⇒ unrestricted, stays visible. A
      // declared visibility array that omits "model" is dropped.
      return visibility === undefined || visibility.includes("model")
    })
    const modelVisibleNames = modelVisible.map(t => t.name)
    expect(modelVisibleNames).toContain("approval_request")
    expect(modelVisibleNames).toContain("approval_get")
    expect(modelVisibleNames).toContain("approval_wait")
    expect(modelVisibleNames).toContain("approval_consume")
    expect(modelVisibleNames).not.toContain("approval_card_decide")
  })
})

describe("Approvals MCP: ui_card channel via a real resources/read", () => {
  it("the ticket from a real resources/read works exactly once", async () => {
    client = await connectClient()
    const requested = parse(
      await client.callTool({
        name: "approval_request",
        arguments: { kind: "send", title: "Send", preview: { to: "a@b.invalid" }, payload: { x: 1 } },
      }),
    )
    const id = requested.id as string
    const meta = requested._meta as { ui?: { resourceUri?: string } } | undefined
    expect(meta?.ui?.resourceUri).toBe(approvalCardResourceUri(id))

    // Re-connect with the resource now registered (the factory-rebuild
    // pattern index.ts uses — see connectClient's per-pending-approval loop).
    await client.close()
    client = await connectClient()

    const read = await client.readResource({ uri: approvalCardResourceUri(id) })
    const content = read.contents[0]
    if (!content || !("text" in content)) throw new Error("resource read returned no text content")
    const html = content.text
    expect(html).toContain("Approve")
    expect(html).toContain("Deny")
    const ticketMatch = html.match(/var TICKET = "([^"]+)"/)
    expect(ticketMatch).toBeTruthy()
    const ticket = ticketMatch![1]!

    const decided = parse(
      await client.callTool({ name: "approval_card_decide", arguments: { approvalId: id, decision: "approve", ticket } }),
    )
    expect(decided.status).toBe("approved")

    // The exact same ticket cannot decide again.
    const replay = await client.callTool({
      name: "approval_card_decide",
      arguments: { approvalId: id, decision: "approve", ticket },
    })
    expect((replay as { isError?: boolean }).isError).toBe(true)
  })

  it("a wrong ticket is refused with a ticket_invalid-shaped error, approval stays pending", async () => {
    client = await connectClient()
    const requested = parse(
      await client.callTool({
        name: "approval_request",
        arguments: { kind: "send", title: "Send", preview: {}, payload: { x: 1 } },
      }),
    )
    const id = requested.id as string
    engine.mintCardTicket(id)

    const res = await client.callTool({
      name: "approval_card_decide",
      arguments: { approvalId: id, decision: "approve", ticket: "wrong-guess" },
    })
    expect((res as { isError?: boolean }).isError).toBe(true)
    const text = (res as { content: Array<{ text?: string }> }).content[0]?.text ?? ""
    expect(text).toContain("ticket_invalid")
    expect(engine.get(id)?.status).toBe("pending")
  })
})

describe("Approvals MCP: the ticket never appears in a model-visible result", () => {
  it("not in approval_request / approval_get / approval_wait / approval_consume", async () => {
    client = await connectClient()
    const requested = parse(
      await client.callTool({
        name: "approval_request",
        arguments: { kind: "send", title: "Send", preview: {}, payload: { x: 1 } },
      }),
    )
    const id = requested.id as string
    const { ticket } = engine.mintCardTicket(id)

    const got = parse(await client.callTool({ name: "approval_get", arguments: { id } }))
    const waitResult = parse(await client.callTool({ name: "approval_wait", arguments: { id, timeoutMs: 50 } }))

    await engine.decideByCard(id, "approve", ticket, { ipAddress: "mcp-app", userAgent: "mcp-app" })
    const consumed = parse(await client.callTool({ name: "approval_consume", arguments: { id, payload: { x: 1 } } }))

    for (const blob of [JSON.stringify(requested), JSON.stringify(got), JSON.stringify(waitResult), JSON.stringify(consumed)]) {
      expect(blob).not.toContain(ticket)
    }
  })
})
