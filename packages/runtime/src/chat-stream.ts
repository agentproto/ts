/**
 * RAW daemon-transcript record → AI SDK `UIMessageChunk` streaming mapper.
 *
 * The `/sessions/:id/chat` (and `/sessions/chat`) HTTP routes fan the daemon's
 * RAW transcript records (`@agentproto/transcript-fixtures` — the shapes
 * `transcript-writer.ts` emits) into the Vercel `ai` v6 "UI message stream"
 * protocol (newline-delimited `UIMessageChunk` objects, SSE-wrapped).
 *
 * This module owns ONLY the pure record→chunk(s) mapping so it can be tested
 * in isolation against the canonical fixture without spinning up a socket.
 * The route wiring (backlog replay + live subscribe + SSE framing) lives in
 * http-server.ts and calls the factory this file exports.
 *
 * State note: `thought` / `text-delta` arrive as fragments (partial markers)
 * and the protocol needs explicit open/end markers, so the mapper keeps
 * per-session segment state (which of reasoning/text is currently open) and a
 * stable, monotonic per-turn `id` reused by every chunk of one assistant
 * message. `turn-end` closes any open segment, emits `finish`, and advances
 * the turn id.
 */

import type { AgentprotoRawTranscriptRecord } from "@agentproto/transcript-fixtures"
import type { UIMessageChunk } from "ai"

/**
 * Log sink for the "unhandled transcript record kind" gate (CONDITION 2).
 * Injected so the conformity test can assert a call was made. Defaults to
 * `console.error` (the COUNT in arbitrage CONDITION 2 demands a real
 * server-side log, never a silent swallow).
 */
export type ChatStreamKindsLogger = (
  kind: string,
  sessionId: string,
  record: AgentprotoRawTranscriptRecord,
) => void

const defaultKindsLogger: ChatStreamKindsLogger = (kind, sessionId) => {
  // CONDITION 2 — never silence an unknown kind server-side.
  console.error(`[chat-stream] unhandled transcript record kind "${kind}" (session ${sessionId})`)
}

/** Stable per-assistant-message id shared by every chunk of one turn. */
function turnMessageId(sessionId: string, turnIndex: number): string {
  return `${sessionId}::assistant-turn-${turnIndex}`
}

/** Coerce a RAW `turn-end.reason` into a valid `ai` `FinishReason`, or
 *  `undefined` (meaning we omit `finishReason` rather than lie). */
function mapFinishReason(reason: string | undefined): Extract<UIMessageChunk, { type: "finish" }>["finishReason"] {
  switch (reason) {
    case "turn-complete":
      return "stop"
    case "turn-error":
      return "error"
    case "turn-length":
      return "length"
    default:
      return undefined
  }
}

/**
 * Build a per-session record→chunks mapper. Each call to the returned function
 * returns the `UIMessageChunk[]` that one RAW record produces in the context
 * of the mapper's accumulated segment state. Deterministic given the record
 * + prior state, so the conformity test can replay the canonical fixture in
 * `seq` order and assert the exact chunk sequence.
 */
export function createTranscriptToUiMapper(
  sessionId: string,
  kindsLogger: ChatStreamKindsLogger = defaultKindsLogger,
): (record: AgentprotoRawTranscriptRecord) => UIMessageChunk[] {
  let turnIndex = 1
  let msgId = turnMessageId(sessionId, turnIndex)
  /** Which text-ish segment is open: a `thought` stream or a `text-delta` stream. */
  let open: "none" | "reasoning" | "text" = "none"

  const closeOpen = (): UIMessageChunk[] => {
    if (open === "reasoning") {
      open = "none"
      return [{ type: "reasoning-end", id: msgId }]
    }
    if (open === "text") {
      open = "none"
      return [{ type: "text-end", id: msgId }]
    }
    return []
  }

  return (record) => {
    switch (record.kind) {
      case "user-prompt": {
        // Echo of the user's input — not assistant output. Emitted on the
        // client by the caller, never surfaced here. We only close any
        // straggler segment left open across a boundary.
        return closeOpen()
      }

      case "thought": {
        // A thought only closes a TEXT segment (reasoning succeeds text in
        // the turn); a follow-up thought in the same reasoning run is a pure
        // delta, not a close-and-reopen.
        const chunks: UIMessageChunk[] = []
        if (open === "text") {
          chunks.push({ type: "text-end", id: msgId })
          open = "none"
        }
        if (open !== "reasoning") {
          chunks.push({ type: "reasoning-start", id: msgId })
          open = "reasoning"
        }
        chunks.push({ type: "reasoning-delta", id: msgId, delta: record.text })
        return chunks
      }

      case "text-delta": {
        // Mirror of `thought`: a text delta closes an open REASONING segment
        // (text follows reasoning in the turn), and stays open across a run of
        // consecutive text-deltas.
        const chunks: UIMessageChunk[] = []
        if (open === "reasoning") {
          chunks.push({ type: "reasoning-end", id: msgId })
          open = "none"
        }
        if (open !== "text") {
          chunks.push({ type: "text-start", id: msgId })
          open = "text"
        }
        chunks.push({ type: "text-delta", id: msgId, delta: record.text })
        return chunks
      }

      case "tool-call": {
        const chunks = closeOpen()
        // `isUpdate` is an enrichment/superseding snapshot of an already
        // announced call — re-emit the same chunk with the fresher input
        // (a trivial, client-mergeable supersede; no cross-call fusion).
        chunks.push({
          type: "tool-input-available",
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          input: record.arguments,
        })
        return chunks
      }

      case "tool-result": {
        const chunks = closeOpen()
        if (record.isError) {
          const r = record.result
          chunks.push({
            type: "tool-output-error",
            toolCallId: record.toolCallId,
            errorText: typeof r === "string" ? r : JSON.stringify(r),
          })
        } else {
          // The RAW result travels as-is — NOT wrapped in `{ output }`; that
          // is client-A's presentation concern, not the AI-SDK protocol.
          chunks.push({
            type: "tool-output-available",
            toolCallId: record.toolCallId,
            output: record.result,
          })
        }
        return chunks
      }

      case "tool-call-record": {
        // DELIBERATE skip — bookkeeping that duplicates tool-call +
        // tool-result. Emitting it would double-render a tool. Not an oubli.
        return []
      }

      case "permission-resolved": {
        // CONDITION 4: the FINAL permission decision travels as a custom data
        // part. `type: \`data-tool-call-approval\`` (`type: \`data-${NAME}\``),
        // aligned with Mastra's `tool-call-approval` vocabulary — NOT the ai@6
        // native `tool-approval-request` chunk, which models a PENDING request.
        const chunks = closeOpen()
        chunks.push({
          type: "data-tool-call-approval",
          data: {
            toolCallId: record.toolCallId,
            decision: record.decision,
            ...(record.optionId ? { optionId: record.optionId } : {}),
          },
        } as UIMessageChunk)
        return chunks
      }

      case "turn-end": {
        const chunks = closeOpen()
        const finishReason = mapFinishReason(record.reason)
        chunks.push(finishReason ? { type: "finish", finishReason } : { type: "finish" })
        turnIndex += 1
        msgId = turnMessageId(sessionId, turnIndex)
        return chunks
      }

      default: {
        // CONDITION 2 — NON-NEGOTIABLE: an unhandled kind is an explicit
        // error + a server-side log, never a silent `"other"` swallow.
        const chunks = closeOpen()
        const label = `unhandled transcript record kind: ${record.kind}`
        kindsLogger(record.kind, sessionId, record)
        chunks.push({ type: "error", errorText: label })
        return chunks
      }
    }
  }
}