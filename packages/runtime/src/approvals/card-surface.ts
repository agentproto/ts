/**
 * The `?surface=approval-cards` MCP connection: the app-only
 * `approval_card_decide` and `approval_card_list`, one card resource per pending approval, and the
 * model-visible `approval_pending` widget tool with its list resource (what
 * Claude Desktop renders: it draws a widget from the tool DEFINITION's
 * `_meta.ui.resourceUri`, so a card that only a per-result `_meta` points at
 * never shows up there).
 *
 * `buildApprovalCardsServer` is the single place that applies the gate, so
 * `index.ts` and the tests exercise the same condition.
 */

import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { defineTool, catchErrors, type ToolContext } from "@agentproto/tool"
import type { DriverHandle } from "@agentproto/driver"
import { registerUiResource, toMcpTool } from "@agentproto/mcp-server"

import { registerApprovalCardDecideTool, registerApprovalCardListTool, requestedByText } from "./card-tool.js"
import {
  APPROVAL_PENDING_RESOURCE_URI,
  approvalCardResourceUri,
  renderApprovalCardHtml,
  renderPendingApprovalsHtml,
} from "./card.js"
import type { ApprovalsEngine } from "./engine.js"

const pendingInputSchema = z.object({})
type PendingInput = z.infer<typeof pendingInputSchema>

const pendingItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  requestedBy: z.string(),
  expiresAt: z.string().optional(),
})
const pendingOutputSchema = z.object({
  count: z.number(),
  pending: z.array(pendingItemSchema),
})
type PendingOutput = z.infer<typeof pendingOutputSchema>

interface PendingContext extends ToolContext {
  engine: ApprovalsEngine
}

const PENDING_TOOL_ID = "approval.pending"

const pendingTool = defineTool<PendingInput, PendingOutput, PendingContext>({
  id: PENDING_TOOL_ID,
  description:
    "Show the human the approvals waiting for a decision, as Approve / Refuse cards. " +
    "Lists them (id, title, kind, requested by, expires at); it can not decide anything.",
  inputSchema: pendingInputSchema,
  outputSchema: pendingOutputSchema,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})

function pendingDriver(): DriverHandle {
  return {
    id: "approval-pending-builtin",
    name: "Approval pending (builtin)",
    description: "Local, in-process list body for approval.pending.",
    kind: "builtin",
    implements: [{ tool: PENDING_TOOL_ID, version: "*" }],
    execute: {
      [PENDING_TOOL_ID]: async ({ context }) => {
        const { engine } = context as PendingContext
        const pending = engine.list({ status: "pending" }).map(record => ({
          id: record.id,
          title: record.title,
          kind: record.kind,
          requestedBy: requestedByText(record),
          ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
        }))
        return { count: pending.length, pending }
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

export function registerApprovalPendingTool(server: McpServer, engine: ApprovalsEngine): void {
  toMcpTool(server, {
    tool: pendingTool,
    candidates: [pendingDriver()],
    context: { engine },
    transformers: [catchErrors()],
    ui: {
      resourceUri: APPROVAL_PENDING_RESOURCE_URI,
      visibility: ["model", "app"],
    },
  })
}

export interface ApprovalCardSurfaceContext {
  /** `?surface=` of this `/mcp` connection. */
  surface?: string | undefined
  /** `?callerSessionId=` of this connection: set means an agent session. */
  callerSessionId?: string | undefined
}

/**
 * The `?surface=approval-cards` server, or `undefined` for any other
 * connection. It is a cards-only surface: `approval_card_decide`,
 * `approval_card_list`, `approval_pending`, the pending list resource and one card resource per
 * pending approval, and NOTHING else (no root tools, no deferral wrapper),
 * so the Claude Desktop entry that dials it does not repeat the daemon's whole
 * tool list next to the main `agentproto` entry.
 *
 * SECURITY BOUNDARY: only the dedicated `approval-cards` surface, and never
 * with a `callerSessionId` (`handleMcp` already refuses that pair with a 403;
 * this check is defense in depth). Every other connection gets NONE of it: an
 * agent CLI's model can usually `resources/read` and call app-only tools
 * despite `_meta.ui.visibility: ["app"]`, so mounting a card there would let
 * an agent mint its own ticket and self-approve.
 *
 * Re-derived from the engine's pending set on every build (the factory runs
 * once per stateless `/mcp` connection, so a resource registered inside a
 * tool handler would vanish before the next connection could read it).
 */
export function buildApprovalCardsServer(
  engine: ApprovalsEngine,
  ctx: ApprovalCardSurfaceContext,
  info: { name: string; version: string },
): McpServer | undefined {
  if (ctx.surface !== "approval-cards" || ctx.callerSessionId) return undefined
  const server = new McpServer({ name: info.name, version: info.version })
  registerApprovalCardDecideTool(server, engine)
  registerApprovalCardListTool(server, engine)
  registerApprovalPendingTool(server, engine)
  registerUiResource(server, {
    name: "approval-pending",
    uri: APPROVAL_PENDING_RESOURCE_URI,
    html: () => renderPendingApprovalsHtml(),
    description: "Pending human approvals",
  })
  for (const pending of engine.list({ status: "pending" })) {
    registerUiResource(server, {
      name: `approval-${pending.id}`,
      uri: approvalCardResourceUri(pending.id),
      html: () => renderApprovalCardHtml(pending.id),
      description: "Human approval card",
    })
  }
  return server
}
