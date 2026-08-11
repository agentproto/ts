/**
 * Best-effort context handoff for a blank-fallback resume (Fix D).
 *
 * When a resume degrades all the way to a fresh spawn — the adapter's own
 * conversation store is missing (a rejected `resumeSessionId`), or the
 * adapter declared `capabilities.resumable: false` — the session comes back
 * with zero context (PR #719 made that honest via `resumeFallback` /
 * `contextNotRestored` rather than silently pretending otherwise). This
 * module reconstructs a bounded summary from the daemon's OWN transcript
 * (`events.jsonl`, written by transcript-writer.ts, which survives both of
 * those cases) so the fresh session isn't flying completely blind.
 *
 * This is a SUMMARY presented as content, not true state restoration — the
 * frame text says so explicitly, and callers must gate injection strictly
 * on the blank-fallback flags (see `SessionDescriptor.pendingResumeContext`)
 * so a session that resumed for real is never double-fed its own context.
 */

import { exportDaemonEventsSession, renderMarkdown, type ExportedMessage } from "./transcript-export.js"

/** Hard cap on the rendered digest, in characters — keeps a long-lived
 *  prior session's transcript from blowing the fresh spawn's very first
 *  turn back up to (or past) full context. */
const DIGEST_CHAR_BUDGET = 7000

/** Tool-result bodies can be whole files; render at most this many chars of
 *  each (`renderMarkdown`'s own per-tool-message truncation knob). */
const TOOL_CHAR_CAP = 200

const DIGEST_FRAME =
  "[resumed session — prior conversation could not be natively restored; " +
  "the following is a best-effort summary reconstructed from the daemon " +
  "transcript, not full context:]\n\n"

function approxMessageLen(m: ExportedMessage): number {
  const toolLen =
    m.toolCalls?.reduce((sum, tc) => sum + tc.name.length + Math.min(tc.args.length, TOOL_CHAR_CAP), 0) ?? 0
  return (m.text?.length ?? 0) + (m.reasoning?.length ?? 0) + toolLen + 32
}

/**
 * Result of attempting to build a resume context digest — explicitly
 * distinguishes "no context at all" from "partial context recovered
 * from daemon transcript" so the restart banner can be honest about
 * what was recovered.
 */
export interface ResumeContextDigestResult {
  /** The framed digest text to inject as the first user message, when
   *  `hasContent` is true. Undefined when no digest could be built. */
  digest?: string
  /** True when the digest contains actual conversation content (at least
   *  one message recovered from the daemon transcript), false when the
   *  daemon transcript was empty or missing. This lets callers
   *  distinguish "fresh with zero context" from "fresh with partial
   *  digest injected" — the banner changes accordingly. */
  hasContent: boolean
}

/**
 * Builds a bounded, tool-truncated, most-recent-turns-first digest of
 * `sessionId`'s daemon-events transcript, framed as an explicit best-effort
 * summary. Returns `{ hasContent: false }` when there's nothing to summarize
 * (no `events.jsonl` for this session, or an empty one), and
 * `{ digest, hasContent: true }` when at least one message was recovered.
 */
export async function buildResumeContextDigest(sessionId: string): Promise<ResumeContextDigestResult> {
  let messages: ExportedMessage[]
  try {
    messages = (await exportDaemonEventsSession(sessionId)).messages
  } catch {
    return { hasContent: false }
  }
  if (messages.length === 0) return { hasContent: false }

  // Keep the most recent turns: walk backward from the end, accumulating an
  // approximate rendered length, and stop once the budget is spent —
  // always keeping at least the single most recent message even if it
  // alone is over budget, so a digest is never dropped entirely just
  // because the last turn was large.
  let total = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    const next = total + approxMessageLen(m)
    if (next > DIGEST_CHAR_BUDGET && start < messages.length) break
    total = next
    start = i
  }

  const rendered = renderMarkdown(
    { meta: {}, messages: messages.slice(start) },
    { maxToolChars: TOOL_CHAR_CAP },
  )
  const body =
    rendered.length > DIGEST_CHAR_BUDGET
      ? `${rendered.slice(0, DIGEST_CHAR_BUDGET)}\n… [${rendered.length - DIGEST_CHAR_BUDGET} chars truncated]`
      : rendered

  return {
    digest: DIGEST_FRAME + body,
    hasContent: true,
  }
}
