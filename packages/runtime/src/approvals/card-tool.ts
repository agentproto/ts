/**
 * `approval_card_list`: app-only: hands the card pages the approvals they
 * render, each with a freshly minted one-time ticket.
 *
 * `approval_card_decide` — the ONLY tool that can decide through the
 * `ui_card` channel. Registered through `toMcpTool` (AIP-14/AIP-30) with
 * `ui.visibility: ["app"]` so its definition-level `_meta.ui.visibility`
 * never carries `"model"` — a host that filters tool lists for its model
 * the way the MCP Apps spec asks ("drop anything whose visibility lacks
 * 'model'") drops this one. It is reachable only from the card's own
 * inline JS (`card.ts`), over the same MCP connection, never from an
 * agent's tool-calling loop.
 *
 * The driver body is a trivial local dispatch (`kind: "builtin"`, one
 * `execute` entry) — no HTTP, no resolver-worthy provider choice — mirrors
 * `workflow-tool-registry.ts`'s `daemon-tool-dispatch` driver.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { defineTool, catchErrors, type ToolContext } from "@agentproto/tool"
import type { DriverHandle } from "@agentproto/driver"
import { toMcpTool } from "@agentproto/mcp-server"

import { CardTicketError, type ApprovalRecord } from "./types.js"
import type { ApprovalsEngine } from "./engine.js"
import { approvalCardResourceUri } from "./card.js"

const cardDecideInputSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
  ticket: z.string().min(1),
})
type CardDecideInput = z.infer<typeof cardDecideInputSchema>

const cardDecideOutputSchema = z.object({
  approvalId: z.string(),
  status: z.string(),
})
type CardDecideOutput = z.infer<typeof cardDecideOutputSchema>

interface CardDecideContext extends ToolContext {
  engine: ApprovalsEngine
}

const CARD_DECIDE_TOOL_ID = "approval.card_decide"

const cardDecideTool = defineTool<CardDecideInput, CardDecideOutput, CardDecideContext>({
  id: CARD_DECIDE_TOOL_ID,
  description:
    "Decide a pending approval from its ui:// card. App-only: a host must never expose this to its model.",
  inputSchema: cardDecideInputSchema,
  outputSchema: cardDecideOutputSchema,
  mutates: ["approval"],
  approval: "auto",
  riskLevel: 0,
})

function cardDecideDriver(): DriverHandle {
  return {
    id: "approval-card-decide-builtin",
    name: "Approval card decide (builtin)",
    description: "Local, in-process decide body for approval.card_decide.",
    kind: "builtin",
    implements: [{ tool: CARD_DECIDE_TOOL_ID, version: "*" }],
    execute: {
      [CARD_DECIDE_TOOL_ID]: async ({ input, context }) => {
        const { engine } = context as CardDecideContext
        const { approvalId, decision, ticket } = input as CardDecideInput
        try {
          const record = await engine.decideByCard(approvalId, decision, ticket, {
            ipAddress: "mcp-app",
            userAgent: "mcp-app",
          })
          return { approvalId: record.id, status: record.status }
        } catch (err) {
          if (err instanceof CardTicketError) {
            throw new Error(`ticket_invalid: ${err.code}`)
          }
          throw err
        }
      },
    },
    install: [],
    network: { egress: [], ingress: [] },
    region: ["global"],
    policyTags: [],
    tags: [],
    metadata: {},
  }
}

export function registerApprovalCardDecideTool(server: McpServer, engine: ApprovalsEngine): void {
  toMcpTool(server, {
    tool: cardDecideTool,
    candidates: [cardDecideDriver()],
    context: { engine },
    transformers: [catchErrors()],
    ui: {
      // Not one specific approval's card — the tool is a shared decide
      // endpoint every card's HTML calls into. Individual cards live at
      // `approvalCardResourceUri(id)`.
      resourceUri: approvalCardResourceUri("_any"),
      visibility: ["app"],
    },
  })
}

const cardListInputSchema = z.object({
  approvalId: z.string().min(1).optional(),
})
type CardListInput = z.infer<typeof cardListInputSchema>

const cardListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  preview: z.unknown().optional(),
  requestedBy: z.string(),
  status: z.string(),
  /** The approval's own expiry. Never the ticket's. */
  expiresAt: z.string().optional(),
  /** One-time decide ticket; present only while the approval is pending. */
  ticket: z.string().optional(),
})
const cardListOutputSchema = z.object({
  approvals: z.array(cardListItemSchema),
})
type CardListOutput = z.infer<typeof cardListOutputSchema>

const CARD_LIST_TOOL_ID = "approval.card_list"

const cardListTool = defineTool<CardListInput, CardListOutput, CardDecideContext>({
  id: CARD_LIST_TOOL_ID,
  description:
    "List the pending approvals for their ui:// cards, each with a one-time decide ticket. App-only: a host must never expose this to its model.",
  inputSchema: cardListInputSchema,
  outputSchema: cardListOutputSchema,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})

export function requestedByText(record: ApprovalRecord): string {
  return "sessionId" in record.requestedBy ? record.requestedBy.sessionId : "operator"
}

function cardListDriver(): DriverHandle {
  return {
    id: "approval-card-list-builtin",
    name: "Approval card list (builtin)",
    description: "Local, in-process list body for approval.card_list.",
    kind: "builtin",
    implements: [{ tool: CARD_LIST_TOOL_ID, version: "*" }],
    execute: {
      [CARD_LIST_TOOL_ID]: async ({ input, context }) => {
        const { engine } = context as CardDecideContext
        const { approvalId } = input as CardListInput
        const records =
          approvalId === undefined
            ? engine.list({ status: "pending" })
            : [engine.get(approvalId)].filter((r): r is ApprovalRecord => r !== undefined)
        const approvals: CardListOutput["approvals"] = []
        for (const record of records) {
          let ticket: string | undefined
          if (record.status === "pending") {
            try {
              ticket = engine.mintCardTicket(record.id).ticket
            } catch {
              // Decided or expired between the read and the mint: skip it.
              if (approvalId === undefined) continue
            }
          }
          approvals.push({
            id: record.id,
            title: record.title,
            kind: record.kind,
            ...(record.preview !== undefined ? { preview: record.preview } : {}),
            requestedBy: requestedByText(record),
            status: engine.get(record.id)?.status ?? record.status,
            ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
            ...(ticket !== undefined ? { ticket } : {}),
          })
        }
        return { approvals }
      },
    },
    install: [],
    network: { egress: [], ingress: [] },
    region: ["global"],
    policyTags: [],
    tags: [],
    metadata: {},
  }
}

export function registerApprovalCardListTool(server: McpServer, engine: ApprovalsEngine): void {
  toMcpTool(server, {
    tool: cardListTool,
    candidates: [cardListDriver()],
    context: { engine },
    transformers: [catchErrors()],
    ui: {
      resourceUri: approvalCardResourceUri("_any"),
      visibility: ["app"],
    },
  })
}
