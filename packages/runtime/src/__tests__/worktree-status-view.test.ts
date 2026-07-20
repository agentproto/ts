/**
 * Unit tests for the pure `toWorktreeStatusView` projection and the
 * `openOnly` filter shape. These are cheap: no git, no forge, no daemon.
 */

import { describe, it, expect } from "vitest"
import {
  toWorktreeStatusView,
  type WorktreeStatusView,
} from "../worktree-status.js"

function makeEntry(
  overrides: Partial<Parameters<typeof toWorktreeStatusView>[0]> = {},
): Parameters<typeof toWorktreeStatusView>[0] {
  return {
    path: "/tmp/wt/foo",
    branch: "wt/foo",
    class: "hold",
    reclaimable: false,
    integration: { state: "unpushed", aheadBy: 3 },
    liveness: { state: "idle", sessions: [] },
    provenance: { sessions: [] },
    ...overrides,
  } as Parameters<typeof toWorktreeStatusView>[0]
}

describe("toWorktreeStatusView", () => {
  it("passes through core scalar fields", () => {
    const view = toWorktreeStatusView(makeEntry())
    expect(view.path).toBe("/tmp/wt/foo")
    expect(view.branch).toBe("wt/foo")
    expect(view.class).toBe("hold")
    expect(view.reclaimable).toBe(false)
  })

  it("projects an open PR as {state:'open', number}", () => {
    const view = toWorktreeStatusView(
      makeEntry({ integration: { state: "open", pr: 42 } }),
    )
    expect(view.pr).toEqual({ state: "open", number: 42 })
  })

  it("projects a merged PR as {state:'merged'} without number", () => {
    const view = toWorktreeStatusView(
      makeEntry({ integration: { state: "merged", via: "squash", pr: 42, offline: false } }),
    )
    expect(view.pr).toEqual({ state: "merged" })
  })

  it("passes through unpushed / pushed-no-pr / local-only states", () => {
    expect(
      toWorktreeStatusView(makeEntry({ integration: { state: "unpushed", aheadBy: 2 } })).pr,
    ).toEqual({ state: "unpushed" })
    expect(
      toWorktreeStatusView(makeEntry({ integration: { state: "pushed-no-pr" } })).pr,
    ).toEqual({ state: "pushed-no-pr" })
    expect(
      toWorktreeStatusView(makeEntry({ integration: { state: "local-only" } })).pr,
    ).toEqual({ state: "local-only" })
  })

  it("trims provenance sessions to the documented fields", () => {
    const view = toWorktreeStatusView(
      makeEntry({
        provenance: {
          sessions: [
            {
              id: "s1",
              adapterSlug: "claude-code",
              model: "claude-opus-4",
              status: "running",
              startedAt: "2026-07-20T10:00:00Z",
              label: "should be dropped",
              cwd: "/tmp/wt/foo",
            } as never,
          ],
        },
      }),
    )
    expect(view.sessions).toEqual([
      {
        id: "s1",
        adapterSlug: "claude-code",
        model: "claude-opus-4",
        status: "running",
        startedAt: "2026-07-20T10:00:00Z",
      },
    ])
  })

  it("omits optional session fields when absent", () => {
    const view = toWorktreeStatusView(
      makeEntry({
        provenance: {
          sessions: [
            {
              id: "s2",
              status: "exited",
              startedAt: "2026-07-20T09:00:00Z",
            } as never,
          ],
        },
      }),
    )
    expect(view.sessions[0]).toEqual({
      id: "s2",
      status: "exited",
      startedAt: "2026-07-20T09:00:00Z",
    })
  })

  it("summarizes liveness as {state, sessionCount}", () => {
    const idle = toWorktreeStatusView(makeEntry({ liveness: { state: "idle", sessions: [] } }))
    expect(idle.liveness).toEqual({ state: "idle", sessionCount: 0 })

    const live = toWorktreeStatusView(
      makeEntry({
        liveness: {
          state: "sessions",
          sessions: [{ id: "s1" } as never, { id: "s2" } as never],
        },
      }),
    )
    expect(live.liveness).toEqual({ state: "sessions", sessionCount: 2 })
  })
})

describe("openOnly filter shape", () => {
  it("keeps only entries whose pr.state is 'open'", () => {
    const rows: WorktreeStatusView[] = [
      { ...toWorktreeStatusView(makeEntry({ integration: { state: "open", pr: 1 } })), path: "a" },
      { ...toWorktreeStatusView(makeEntry({ integration: { state: "merged", pr: 2 } })), path: "b" },
      { ...toWorktreeStatusView(makeEntry({ integration: { state: "unpushed" } })), path: "c" },
    ]
    const open = rows.filter(w => w.pr?.state === "open")
    expect(open.map(w => w.path)).toEqual(["a"])
  })
})
