/**
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

import { CardTicketError } from "./types.js"
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
