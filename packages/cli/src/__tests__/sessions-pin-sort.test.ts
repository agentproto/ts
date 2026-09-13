/**
 * Unit tests for `sortPinnedFirst` (`commands/sessions.ts`) — the pure
 * helper `printTable` uses to surface pinned sessions at the top of the
 * default `agentproto sessions` table (and its `--watch` variants, which
 * reuse the same `printTable`).
 */

import { describe, it, expect } from "vitest"
import { sortPinnedFirst } from "../commands/sessions.js"
import type { SessionDescriptor } from "@agentproto/runtime"

function session(id: string, over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id,
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude-code --print",
    pid: 1,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

describe("sortPinnedFirst", () => {
  it("moves pinned sessions to the top", () => {
    const rows = [session("a"), session("b", { pinned: true }), session("c")]
    expect(sortPinnedFirst(rows).map(r => r.id)).toEqual(["b", "a", "c"])
  })

  it("keeps relative order within the pinned group and within the rest", () => {
    const rows = [
      session("a", { pinned: true }),
      session("b"),
      session("c", { pinned: true }),
      session("d"),
    ]
    expect(sortPinnedFirst(rows).map(r => r.id)).toEqual(["a", "c", "b", "d"])
  })

  it("is a no-op ordering when nothing is pinned", () => {
    const rows = [session("a"), session("b"), session("c")]
    expect(sortPinnedFirst(rows).map(r => r.id)).toEqual(["a", "b", "c"])
  })

  it("does not mutate the input array", () => {
    const rows = [session("a"), session("b", { pinned: true })]
    const copy = [...rows]
    sortPinnedFirst(rows)
    expect(rows).toEqual(copy)
  })
})
