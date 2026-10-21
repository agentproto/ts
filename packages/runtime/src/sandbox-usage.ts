/**
 * Projection of a REMOTE daemon's `session_usage` answer onto the local
 * descriptor's usage fields.
 *
 * A sandboxed session runs inside a box that has its own daemon, so its
 * usage is read back over the wire: the box's `session_usage` tool answers
 * with model / cost / token counts / context window, and the HOST projects
 * that answer onto its own descriptor (the `readUsage` hook every adapter
 * reader implements).
 *
 * The cache split (`cacheReadTokens` / `cacheWriteTokens` /
 * `reasoningTokens`) rides along: the box's answer reports it (claude-code's
 * transcript reader, hermes' state.db), and dropping it here would leave a
 * sandboxed session with input/output tokens but no cache split — a
 * half-usage row that reads as "measured" while the cache half is missing.
 *
 * Every field is forwarded only when the remote side actually reported it, so
 * an absent split stays ABSENT — never a measured 0.
 */

import type { UsageReadResult } from "./usage.js"

/**
 * The remote daemon's `session_usage` answer, widened with the cache split.
 *
 * `SessionUsageSnapshot` (packages/harness) predates the cache split and
 * doesn't declare these fields, but the remote `session_usage` tool DOES
 * return them — they just aren't in the harness's type. Read them through
 * this widened shape.
 */
export type RemoteUsageSnapshot = {
  model?: string
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/**
 * Project a remote `session_usage` answer onto the local usage fields.
 *
 * Returns null when the remote side reported nothing at all — the reader
 * hook's "nothing measured" signal.
 */
export function projectRemoteUsage(snap: RemoteUsageSnapshot): UsageReadResult | null {
  const usage = {
    ...(typeof snap.model === "string" && snap.model.length > 0 ? { model: snap.model } : {}),
    ...(typeof snap.costUsd === "number" ? { costUsd: snap.costUsd } : {}),
    ...(typeof snap.tokensIn === "number" ? { tokensIn: snap.tokensIn } : {}),
    ...(typeof snap.tokensOut === "number" ? { tokensOut: snap.tokensOut } : {}),
    ...(typeof snap.cacheReadTokens === "number" ? { cacheReadTokens: snap.cacheReadTokens } : {}),
    ...(typeof snap.cacheWriteTokens === "number" ? { cacheWriteTokens: snap.cacheWriteTokens } : {}),
    ...(typeof snap.reasoningTokens === "number" ? { reasoningTokens: snap.reasoningTokens } : {}),
  }
  return Object.keys(usage).length > 0 ? usage : null
}
