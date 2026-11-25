/**
 * Two ways a follow used to lose `turn-end`:
 *  1. a supervisor following its own child with an explicit event list that
 *     omits `turn-end` (never woken when the child just finishes);
 *  2. the watched child being restarted under a new id — only the follower
 *     was re-pointed, `selector.sessionIds` kept the dead id.
 */
import { describe, expect, it, vi } from "vitest"
import { createSentinelStore } from "@agentproto/sentinel"

import { createSessionsRegistry } from "../sessions.js"
import { createSessionFollowStore } from "../session-follow-store.js"
import { upsertSessionFollow } from "../session-follow-tools.js"
import { wireRetirementCleanup, sweepWiringLifecycle } from "../retirement-cleanup.js"

const agentSession = (id: string) => ({
  sessionId: `acp_${id}`,
  async *send() {},
  async cancel() {},
  async close() {},
})

function setup(labels: string[]) {
  const registry = createSessionsRegistry({ persist: false })
  const followStore = createSessionFollowStore({ persist: false })
  const sentinelStore = createSentinelStore({ persist: false })
  const ids = labels.map(
    label =>
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        adapterSlug: "fake",
        label,
        agentSession: agentSession(label),
      }).id,
  )
  return { registry, followStore, sentinelStore, ids }
}

describe("parent → child follow always keeps turn-end", () => {
  const deps = (parents: Record<string, string>) => {
    const store = createSessionFollowStore({ persist: false })
    return {
      store,
      hasSession: () => true,
      parentOf: (id: string) => parents[id],
    }
  }

  it("adds turn-end (with a warning) when the follower watches its own child", () => {
    const d = deps({ child: "sup" })
    const res = upsertSessionFollow(d, {
      follower: "sup",
      key: "child",
      selector: { sessionIds: ["child"] },
      events: ["exited", "crashed", "awaiting-input"],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.follow.events).toContain("turn-end")
    expect(res.warnings?.[0]).toMatch(/turn-end/)
  })

  it("also covers a grandchild, and leaves unrelated sessions alone", () => {
    const d = deps({ child: "sup", grand: "child" })
    const a = upsertSessionFollow(d, { follower: "sup", selector: { sessionIds: ["grand"] }, events: ["exited"] })
    expect(a.ok && a.follow.events).toContain("turn-end")
    const b = upsertSessionFollow(d, { follower: "sup", selector: { sessionIds: ["other"] }, events: ["exited"] })
    expect(b.ok && b.follow.events).toEqual(["exited"])
  })
})

describe("a follow survives its watched session being restarted", () => {
  it("retirement event re-points selector.sessionIds at the successor", () => {
    const { registry, followStore, sentinelStore, ids } = setup(["sup", "old", "new"])
    const [sup, oldId, newId] = ids as [string, string, string]
    wireRetirementCleanup({ registry, followStore, sentinelStore, cancelSentinel: vi.fn(), log: () => {} })
    followStore.upsert({
      follower: sup,
      key: "child",
      selector: { sessionIds: [oldId] },
      events: ["turn-end", "exited"],
    })
    registry.markRetired(oldId, { continuedTo: newId, cause: "continued" })
    const f = followStore.list()[0]!
    expect(f.selector.sessionIds).toEqual([newId])
    expect(f.events).toEqual(["turn-end", "exited"])
  })

  it("the boot/periodic sweep repairs a follow left on a superseded id", async () => {
    const { registry, followStore, sentinelStore, ids } = setup(["sup", "old", "new"])
    const [sup, oldId, newId] = ids as [string, string, string]
    followStore.upsert({ follower: sup, selector: { sessionIds: [oldId] }, events: ["turn-end"] })
    registry.markRetired(oldId, { continuedTo: newId, cause: "continued" })
    const result = await sweepWiringLifecycle({ registry, followStore, sentinelStore, cancelSentinel: vi.fn(), log: () => {} })
    expect(result.followsRelinked).toBe(1)
    expect(followStore.list()[0]!.selector.sessionIds).toEqual([newId])
  })
})
