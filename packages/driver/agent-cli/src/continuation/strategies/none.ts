/**
 * `none` strategy — pre-AIP-45-extension behaviour.
 *
 * Spawn a fresh session per acquire; close it on release. No state,
 * no reuse. The default when a manifest declares no `continuation`
 * block (back-compat for adapters that haven't been updated).
 */

import type { ContinuationStrategy } from "../types.js"

export const noneStrategy: ContinuationStrategy = {
  id: "none",
  async acquire(ctx) {
    return ctx.runtime.start(ctx.startOptions)
  },
  async release(ctx) {
    await ctx.session.close()
  },
}
