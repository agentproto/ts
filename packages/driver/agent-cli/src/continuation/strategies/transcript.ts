/**
 * `transcript` strategy — works for any CLI, including those with
 * `resumable: false` and ephemeral sessions.
 *
 * The driver doesn't know about Mastra memory or the host's
 * conversation log — that's the host's domain. The host supplies the
 * preamble at acquire-time via `startOptions.config.options` (the
 * convention is option id `__transcript`, see below) and the strategy
 * is otherwise identical to `none` — fresh session per acquire,
 * close on release.
 *
 * In practice the host does the prepending itself before calling
 * `runtime.start` (it controls the `message` text). This strategy
 * exists mostly as a NAMED policy choice in the manifest — declaring
 * it tells the host "use the transcript-replay path for this CLI"
 * without the host needing to inspect capabilities.
 *
 * Token-costly but stateless and survives API restarts.
 */

import type { ContinuationStrategy } from "../types.js"

export const transcriptStrategy: ContinuationStrategy = {
  id: "transcript",
  async acquire(ctx) {
    return ctx.runtime.start(ctx.startOptions)
  },
  async release(ctx) {
    await ctx.session.close()
  },
}
