/**
 * Bureau recipe-write approvals (CONTRACT.md W3).
 *
 * An imported MCP that is a Bureau server (`subsession: "aip-59"`) refuses a
 * gated recipe write with an MCP error result
 * `browser:approval_required`. When that error carries `deviceDecision: true`
 * this bridge turns it into a daemon approval, so the human sees an
 * Approve / Deny card instead of a terminal-only `bureau recipe approve`.
 *
 * The bridge is wired as the `McpProxyRegistry`'s result hook, so it sees
 * every imported tool result exactly once, from both entry points an agent can
 * use: `mcp_imported_call` on the daemon's own `/mcp`, and the per-import
 * mount `/mcp/imported/<id>` that a `browser` bundle gives a harness.
 *
 * On a decision (`approval:decided`) it relays the human's answer to Bureau's
 * device route `POST <import origin>/pair/approvals/<requestId>` (W2) with the
 * import's own connection headers and NO `Agentproto-Subsession` header: only
 * the device credential may decide (CONTRACT.md rule 1), never a sub-session.
 *
 * Nothing here can decide an approval. Only the engine's human channels can.
 */

import type { SessionEventBus, ApprovalDecidedEvent } from "../session-event-bus.js"
import type { SubsessionTarget } from "../subsession-minter.js"
import type { ApprovalsEngine } from "./engine.js"
import { approvalCardResourceUri } from "./card.js"

/** The approval kind this bridge owns. Contract W3 fixes the spelling. */
export const BUREAU_APPROVAL_KIND = "bureau.recipe-write"

/** The fields W1 puts on the `browser:approval_required` error details. */
interface BureauApprovalDetails {
  requestId: string
  recipe: string
  version: string
  tool: string
  inputSha256: string
  preview: string
  expiresAt: string
}

/** Reuse the AIP-59 resolver `createSubsessionMinter` uses: alias or import
 *  id, origin as the base URL, the import's connection headers. `undefined`
 *  means "not a Bureau (`aip-59`) import". */
export type BureauImportResolver = (alias: string) => Promise<SubsessionTarget | undefined>

export interface BureauApprovalBridgeOptions {
  engine: Pick<ApprovalsEngine, "request">
  sessionEvents: SessionEventBus
  resolveImport: BureauImportResolver
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch
  /** Test seam; defaults to `console.warn`. Never receives a secret. */
  log?: (message: string) => void
}

export interface ImportedResultHookCall {
  alias: string
  toolName: string
  result: unknown
  /** The registry's per-call context (same shape as `ProxyCallContext`). */
  context?: { callerSessionId?: string }
}

export interface BureauApprovalBridge {
  /** Post-call hook body: pass the upstream result through, or return a copy
   *  carrying `approvalId`/`waitWith`/`_meta.ui.resourceUri`. Never throws. */
  handleToolResult(call: ImportedResultHookCall): Promise<unknown>
  dispose(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textOfContent(result: Record<string, unknown>): { text: string; index: number } | undefined {
  const content = result.content
  if (!Array.isArray(content)) return undefined
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index]
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      return { text: block.text, index }
    }
  }
  return undefined
}

function parseDetailsBody(body: unknown): BureauApprovalDetails | undefined {
  if (!isRecord(body)) return undefined
  if (body.code !== "browser:approval_required" || body.deviceDecision !== true) return undefined
  const { requestId, recipe, version, tool, inputSha256, preview, expiresAt } = body
  if (
    typeof requestId !== "string" ||
    typeof recipe !== "string" ||
    typeof version !== "string" ||
    typeof tool !== "string" ||
    typeof inputSha256 !== "string" ||
    typeof preview !== "string" ||
    typeof expiresAt !== "string"
  ) {
    return undefined
  }
  return { requestId, recipe, version, tool, inputSha256, preview, expiresAt }
}

/** Read the W1 details out of a Bureau error result. Bureau puts the error
 *  body in the first text content block; `structuredContent` is accepted too,
 *  so a future Bureau that adds it keeps working. */
function readDetails(result: unknown): { details: BureauApprovalDetails; textIndex?: number } | undefined {
  if (!isRecord(result) || result.isError !== true) return undefined
  const content = textOfContent(result)
  if (content) {
    try {
      const details = parseDetailsBody(JSON.parse(content.text))
      if (details) return { details, textIndex: content.index }
    } catch {
      // Not JSON: fall through to structuredContent.
    }
  }
  const details = parseDetailsBody(result.structuredContent)
  return details ? { details } : undefined
}

/** A copy of `result` whose error details now carry `approvalId` and
 *  `waitWith`. The text block is patched in place when it is the JSON body;
 *  otherwise a short note block is appended (contract W3). */
function withApprovalState(
  result: Record<string, unknown>,
  textIndex: number | undefined,
  approvalId: string,
): Record<string, unknown> {
  const content = Array.isArray(result.content) ? [...result.content] : []
  const waitWith = "approval_wait"
  if (textIndex !== undefined) {
    const block = content[textIndex]
    if (isRecord(block) && typeof block.text === "string") {
      try {
        const body = JSON.parse(block.text)
        if (isRecord(body)) {
          content[textIndex] = { ...block, text: JSON.stringify({ ...body, approvalId, waitWith }) }
          return { ...result, content }
        }
      } catch {
        // Not JSON after all: append a note instead of dropping the details.
      }
    }
  }
  content.push({
    type: "text",
    text: `approvalId: ${approvalId}\nwaitWith: ${waitWith}`,
  })
  return { ...result, content }
}

export function createBureauApprovalBridge(opts: BureauApprovalBridgeOptions): BureauApprovalBridge {
  const fetchImpl = opts.fetch ?? fetch
  const log = opts.log ?? ((message: string) => console.warn(message))
  /** approvalId -> what W2 needs to relay the human's decision. */
  const pending = new Map<string, { alias: string; requestId: string; inputSha256: string }>()

  const relay = async (ev: ApprovalDecidedEvent): Promise<void> => {
    const target = pending.get(ev.approvalId)
    if (!target) return
    pending.delete(ev.approvalId)
    let resolved: SubsessionTarget | undefined
    try {
      resolved = await opts.resolveImport(target.alias)
    } catch (err) {
      log(
        `[bureau-approval-bridge] could not resolve import "${target.alias}" for ${ev.approvalId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }
    if (!resolved) {
      log(`[bureau-approval-bridge] import "${target.alias}" is no longer a Bureau import; ${ev.approvalId} not relayed`)
      return
    }
    // Rule 1: the device credential decides. Never present a sub-session
    // token, whatever a caller managed to put on the connection.
    const headers: Record<string, string> = { ...resolved.headers, "content-type": "application/json" }
    delete headers["agentproto-subsession"]
    delete headers["Agentproto-Subsession"]
    const url = `${resolved.baseUrl.replace(/\/+$/, "")}/pair/approvals/${encodeURIComponent(target.requestId)}`
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          decision: ev.decision === "approved" ? "approved" : "denied",
          inputSha256: target.inputSha256,
          decisionRef: ev.approvalId,
        }),
      })
      if (!res.ok) {
        log(
          `[bureau-approval-bridge] W2 for "${target.alias}/${target.requestId}" failed: HTTP ${res.status}`,
        )
      }
    } catch (err) {
      log(
        `[bureau-approval-bridge] W2 for "${target.alias}/${target.requestId}" failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const offDecided = opts.sessionEvents.on("approval:decided", ev => {
    // A bus callback must never throw; `relay` already catches everything.
    void relay(ev).catch(err => {
      log(`[bureau-approval-bridge] relay failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  })
  const offExpired = opts.sessionEvents.on("approval:expired", ev => {
    pending.delete(ev.approvalId)
  })

  return {
    async handleToolResult(call: ImportedResultHookCall): Promise<unknown> {
      try {
        const found = readDetails(call.result)
        if (!found) return call.result
        // Only a Bureau import may create one. A non-Bureau import returning
        // the same text creates no approval (the contract's rule 2).
        const target = await opts.resolveImport(call.alias)
        if (!target) return call.result
        const { details } = found
        const record = opts.engine.request(
          {
            kind: BUREAU_APPROVAL_KIND,
            title: `${details.recipe} · ${details.tool}`,
            preview: {
              recipe: details.recipe,
              version: details.version,
              tool: details.tool,
              preview: details.preview,
              inputSha256: details.inputSha256,
            },
            payload: {
              importAlias: target.key ?? call.alias,
              requestId: details.requestId,
              inputSha256: details.inputSha256,
            },
            expiresAt: details.expiresAt,
          },
          call.context?.callerSessionId
            ? { sessionId: call.context.callerSessionId }
            : { operator: true },
        )
        pending.set(record.id, {
          alias: target.key ?? call.alias,
          requestId: details.requestId,
          inputSha256: details.inputSha256,
        })
        const augmented = withApprovalState(call.result as Record<string, unknown>, found.textIndex, record.id)
        const meta = isRecord(augmented._meta) ? augmented._meta : {}
        return {
          ...augmented,
          _meta: {
            ...meta,
            ui: {
              ...(isRecord(meta.ui) ? meta.ui : {}),
              resourceUri: approvalCardResourceUri(record.id),
            },
          },
        }
      } catch (err) {
        // A bridge failure must never break the forwarded tool result.
        log(`[bureau-approval-bridge] could not create an approval: ${err instanceof Error ? err.message : String(err)}`)
        return call.result
      }
    },

    dispose(): void {
      offDecided()
      offExpired()
      pending.clear()
    },
  }
}
