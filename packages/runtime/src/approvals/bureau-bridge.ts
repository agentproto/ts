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
 * A decision that Bureau did not take (Bureau down, a 5xx) is kept in a small
 * outbox next to the approval record and retried with a bounded backoff while
 * the daemon runs, and once at boot. It stops on a 2xx or on a final answer
 * (`already_decided`, `request_expired`, `request_not_found`). The outbox holds
 * the decision only: never a header value or a credential.
 *
 * A relay that ends (2xx or a final answer) leaves a small `relayed.json`
 * marker. At boot, after the outbox pass, a sweep re-queues every decided
 * Bureau approval that has no outbox entry, no marker and an unexpired Bureau
 * request: the daemon may have died after the engine saved the decision but
 * before the outbox write. Bureau answers a duplicate with `already_decided`.
 *
 * Nothing here can decide an approval. Only the engine's human channels can.
 */

import type { SessionEventBus } from "../session-event-bus.js"
import type { SubsessionTarget } from "../subsession-minter.js"
import type { ApprovalsEngine } from "./engine.js"
import type { ApprovalRecord, RelayOutboxEntry } from "./types.js"
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
  /** `get`/`getPayload` are what make the relay restart-safe: the decision
   *  reads the persisted record and the pinned payload file, never an
   *  in-memory request cache. */
  engine: Pick<
    ApprovalsEngine,
    | "request"
    | "get"
    | "getPayload"
    | "list"
    | "putRelayOutbox"
    | "removeRelayOutbox"
    | "listRelayOutbox"
    | "markRelayed"
    | "isRelayed"
  >
  sessionEvents: SessionEventBus
  resolveImport: BureauImportResolver
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch
  /** Test seam; defaults to `console.warn`. Never receives a secret. */
  log?: (message: string) => void
  /** Outbox retry pacing; tests shrink it. */
  retry?: Partial<RelayRetryOptions>
}

export interface RelayRetryOptions {
  /** First retry delay; doubles each attempt up to `maxDelayMs`. */
  baseDelayMs: number
  maxDelayMs: number
  /** Failed attempts, across restarts, before the entry is dropped. */
  maxAttempts: number
}

const DEFAULT_RETRY: RelayRetryOptions = { baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 20 }

/** Bureau answers that a retry of the same request can never change. */
const FINAL_W2_CODES = new Set([
  "already_decided",
  "request_expired",
  "request_not_found",
  "input_mismatch",
  "wrong_device",
  "subsession_forbidden",
])

/** Used when Bureau's `expiresAt` is missing, unparsable or already past. */
const FALLBACK_TTL_MS = 15 * 60 * 1000

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
  // The structured twin of the details gets the same two fields, so a caller
  // reading `structuredContent` does not have to parse a text note.
  const structured = parseDetailsBody(result.structuredContent)
    ? { structuredContent: { ...(result.structuredContent as Record<string, unknown>), approvalId, waitWith } }
    : {}
  if (textIndex !== undefined) {
    const block = content[textIndex]
    if (isRecord(block) && typeof block.text === "string") {
      try {
        const body = JSON.parse(block.text)
        if (isRecord(body)) {
          content[textIndex] = { ...block, text: JSON.stringify({ ...body, approvalId, waitWith }) }
          return { ...result, ...structured, content }
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
  return { ...result, ...structured, content }
}

/** Bureau's `expiresAt` when it is a real, future instant; otherwise now +
 *  15 minutes, so the approval is never created already expired. */
function usableExpiry(expiresAt: string, now: number): { value: string; fallback: boolean } {
  const parsed = Date.parse(expiresAt)
  if (Number.isFinite(parsed) && parsed > now) return { value: expiresAt, fallback: false }
  return { value: new Date(now + FALLBACK_TTL_MS).toISOString(), fallback: true }
}

export function createBureauApprovalBridge(opts: BureauApprovalBridgeOptions): BureauApprovalBridge {
  const fetchImpl = opts.fetch ?? fetch
  const log = opts.log ?? ((message: string) => console.warn(message))

  /** The W2 relay input, taken from the PERSISTED record plus the pinned
   *  payload file so a daemon restart between the request and the human's
   *  click still relays. A malformed payload is not a Bureau approval this
   *  bridge understands. */
  const relayTargetOf = (
    record: { kind: string } | undefined,
    payload: unknown,
  ): { importAlias: string; requestId: string; inputSha256: string } | undefined => {
    if (!record || record.kind !== BUREAU_APPROVAL_KIND || !isRecord(payload)) return undefined
    const { importAlias, requestId, inputSha256 } = payload
    if (
      typeof importAlias !== "string" ||
      typeof requestId !== "string" ||
      typeof inputSha256 !== "string" ||
      importAlias === "" ||
      requestId === "" ||
      inputSha256 === ""
    ) {
      return undefined
    }
    return { importAlias, requestId, inputSha256 }
  }

  const retry: RelayRetryOptions = { ...DEFAULT_RETRY, ...opts.retry }
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const busy = new Set<string>()
  let disposed = false

  /** One W2 POST for a queued decision. `done` means stop for good (2xx, a
   *  final Bureau answer, or nothing left to relay); `retry` means try later. */
  const send = async (entry: RelayOutboxEntry): Promise<"done" | "retry"> => {
    const target = relayTargetOf(opts.engine.get(entry.approvalId), opts.engine.getPayload(entry.approvalId))
    if (!target) return "done"
    let resolved: SubsessionTarget | undefined
    try {
      resolved = await opts.resolveImport(target.importAlias)
    } catch (err) {
      log(
        `[bureau-approval-bridge] could not resolve import "${target.importAlias}" for ${entry.approvalId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      return "retry"
    }
    if (!resolved) {
      log(
        `[bureau-approval-bridge] import "${target.importAlias}" is no longer a Bureau import; ${entry.approvalId} not relayed`,
      )
      return "done"
    }
    // Rule 1: the device credential decides. Never present a sub-session
    // token, whatever a caller managed to put on the connection. Header
    // names are case-insensitive, so strip any casing.
    const headers: Record<string, string> = { ...resolved.headers, "content-type": "application/json" }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "agentproto-subsession") delete headers[key]
    }
    const url = `${resolved.baseUrl.replace(/\/+$/, "")}/pair/approvals/${encodeURIComponent(target.requestId)}`
    const label = `"${target.importAlias}/${target.requestId}"`
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          decision: entry.decision,
          inputSha256: target.inputSha256,
          decisionRef: entry.approvalId,
        }),
      })
      if (res.ok) return "done"
      let code: string | undefined
      try {
        const body: unknown = JSON.parse(await res.text())
        if (isRecord(body)) {
          const raw = body.error ?? body.code
          if (typeof raw === "string") code = raw
        }
      } catch {
        // No JSON body: judge by status alone.
      }
      const final = res.status === 410 || (code !== undefined && FINAL_W2_CODES.has(code))
      log(
        `[bureau-approval-bridge] W2 for ${label} failed: HTTP ${res.status}` +
          `${code ? ` (${code})` : ""}${final ? ", final" : ""}`,
      )
      return final ? "done" : "retry"
    } catch (err) {
      log(
        `[bureau-approval-bridge] W2 for ${label} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      return "retry"
    }
  }

  const deliver = async (entry: RelayOutboxEntry): Promise<void> => {
    const id = entry.approvalId
    if (disposed || busy.has(id) || timers.has(id)) return
    busy.add(id)
    try {
      if ((await send(entry)) === "done") {
        opts.engine.markRelayed(id)
        opts.engine.removeRelayOutbox(id)
        return
      }
      const next: RelayOutboxEntry = { ...entry, attempts: entry.attempts + 1 }
      if (next.attempts >= retry.maxAttempts) {
        log(`[bureau-approval-bridge] giving up relaying ${id} after ${next.attempts} attempts`)
        opts.engine.removeRelayOutbox(id)
        return
      }
      opts.engine.putRelayOutbox(next)
      if (disposed) return
      const delay = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (next.attempts - 1))
      const timer = setTimeout(() => {
        timers.delete(id)
        void deliver(next).catch(err => {
          log(`[bureau-approval-bridge] relay failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }, delay)
      timer.unref?.()
      timers.set(id, timer)
    } finally {
      busy.delete(id)
    }
  }

  const enqueued = new Set<string>()

  /** Persist the entry before the first send: a crash mid-flight still relays
   *  at boot. */
  const enqueue = (approvalId: string, decision: "approved" | "denied"): void => {
    // The boot sweep can see a decision whose `approval:decided` event is still
    // on its way (the engine saves the decision before it signs and emits).
    if (enqueued.has(approvalId)) return
    enqueued.add(approvalId)
    const entry: RelayOutboxEntry = {
      approvalId,
      decision,
      attempts: 0,
      queuedAt: new Date().toISOString(),
    }
    opts.engine.putRelayOutbox(entry)
    void deliver(entry).catch(err => {
      log(`[bureau-approval-bridge] relay failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const offDecided = opts.sessionEvents.on("approval:decided", ev => {
    // A bus callback must never throw.
    try {
      if (!relayTargetOf(opts.engine.get(ev.approvalId), opts.engine.getPayload(ev.approvalId))) return
      enqueue(ev.approvalId, ev.decision === "approved" ? "approved" : "denied")
    } catch (err) {
      log(`[bureau-approval-bridge] relay failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // Boot pass: anything decided but not delivered before the last shutdown.
  queueMicrotask(() => {
    const queued = new Set<string>()
    try {
      for (const entry of opts.engine.listRelayOutbox()) {
        queued.add(entry.approvalId)
        void deliver(entry).catch(err => {
          log(`[bureau-approval-bridge] relay failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    } catch (err) {
      log(`[bureau-approval-bridge] could not read the relay outbox: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Sweep: a decision the engine saved but the outbox never got (the daemon
    // died in between). The Bureau request must still be open; Bureau answers
    // a duplicate with `already_decided`, so a double relay is harmless.
    try {
      const now = Date.now()
      for (const record of opts.engine.list()) {
        if (disposed) return
        if (record.kind !== BUREAU_APPROVAL_KIND) continue
        const decision = record.decision?.decision
        if ((record.status !== "approved" && record.status !== "denied") || !decision) continue
        if (queued.has(record.id) || opts.engine.isRelayed(record.id)) continue
        if (!relayTargetOf(record, opts.engine.getPayload(record.id))) continue
        const expiresAt = record.expiresAt ? Date.parse(record.expiresAt) : Number.NaN
        if (!Number.isFinite(expiresAt) || expiresAt <= now) continue
        enqueue(record.id, decision)
      }
    } catch (err) {
      log(`[bureau-approval-bridge] could not sweep decided approvals: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  /** A pending approval already created for this Bureau request, so an agent
   *  that retries before anyone decides gets the same card, not a second one. */
  const findPending = (importAlias: string, requestId: string): ApprovalRecord | undefined => {
    for (const record of opts.engine.list({ status: "pending" })) {
      const existing = relayTargetOf(record, opts.engine.getPayload(record.id))
      if (existing && existing.importAlias === importAlias && existing.requestId === requestId) return record
    }
    return undefined
  }

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
        const expiry = usableExpiry(details.expiresAt, Date.now())
        if (expiry.fallback) {
          log(
            `[bureau-approval-bridge] Bureau expiresAt for "${details.requestId}" is invalid or already past; ` +
              `using now + 15 min`,
          )
        }
        const importAlias = target.key ?? call.alias
        const record =
          findPending(importAlias, details.requestId) ??
          opts.engine.request(
            {
              kind: BUREAU_APPROVAL_KIND,
              title: `${details.recipe} · ${details.tool}`,
              preview: {
                summary: `Write recipe ${details.recipe} v${details.version} through ${details.tool}`,
                ...(details.preview.length > 0
                  ? { sections: [{ title: "What will change", text: details.preview }] }
                  : {}),
                recipe: details.recipe,
                version: details.version,
                tool: details.tool,
                preview: details.preview,
                inputSha256: details.inputSha256,
              },
              payload: {
                importAlias,
                requestId: details.requestId,
                inputSha256: details.inputSha256,
              },
              expiresAt: expiry.value,
            },
            call.context?.callerSessionId
              ? { sessionId: call.context.callerSessionId }
              : { operator: true },
          )
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
      disposed = true
      offDecided()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
