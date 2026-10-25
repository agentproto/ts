/**
 * Reaction context: AsyncLocalStorage carrying and spawn stamping.
 */

import { describe, expect, it } from "vitest"

import {
  currentReactionContext,
  reactionSpawnStamp,
  runInReactionContext,
  type ReactionContext,
} from "../action-hooks/index.js"

const ctx = (bindingId: string, reactionDepth: number): ReactionContext => ({
  bindingId,
  reactionDepth,
  causedByEventId: `receipt:${bindingId}`,
})

describe("reaction context", () => {
  it("is undefined outside and visible after an await, in a timer and in a Promise.all branch", async () => {
    expect(currentReactionContext()).toBeUndefined()

    const seen = await runInReactionContext(ctx("bind-a", 1), async () => {
      const afterAwait = currentReactionContext()
      const timer = await new Promise<ReactionContext | undefined>(resolve => {
        setTimeout(() => resolve(currentReactionContext()), 0)
      })
      const branches = await Promise.all([
        Promise.resolve().then(() => currentReactionContext()),
        Promise.resolve().then(() => currentReactionContext()),
      ])
      return { afterAwait, timer, branches }
    })

    expect(seen.afterAwait).toEqual(ctx("bind-a", 1))
    expect(seen.timer).toEqual(ctx("bind-a", 1))
    expect(seen.branches).toEqual([ctx("bind-a", 1), ctx("bind-a", 1)])
    expect(currentReactionContext()).toBeUndefined()
  })

  it("keeps two concurrent contexts separate", async () => {
    const [a, b] = await Promise.all([
      runInReactionContext(ctx("bind-a", 2), async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return currentReactionContext()
      }),
      runInReactionContext(ctx("bind-b", 3), async () => {
        await new Promise(resolve => setTimeout(resolve, 1))
        return currentReactionContext()
      }),
    ])

    expect(a).toEqual(ctx("bind-a", 2))
    expect(b).toEqual(ctx("bind-b", 3))
  })

  it("stamps a spawn with the binding origin and the reaction meta", () => {
    expect(reactionSpawnStamp(undefined)).toBeUndefined()
    expect(reactionSpawnStamp("author")).toBeUndefined()

    const stamp = runInReactionContext(ctx("bind-a", 2), async () => reactionSpawnStamp(undefined))
    const explicit = runInReactionContext(ctx("bind-a", 2), async () => reactionSpawnStamp("author"))

    return Promise.all([stamp, explicit]).then(([generated, kept]) => {
      expect(generated).toEqual({
        origin: "reaction:bind-a",
        meta: { reactionDepth: 2, causedByEventId: "receipt:bind-a" },
      })
      expect(kept).toEqual({
        origin: "author",
        meta: { reactionDepth: 2, causedByEventId: "receipt:bind-a" },
      })
    })
  })
})
