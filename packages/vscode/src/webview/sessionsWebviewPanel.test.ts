/**
 * Host-glue persistence for the workspace color picker — the constructor's
 * globalState hydration and `setColor`'s persist-then-repost path
 * (sessionsWebviewPanel.ts) are deliberately thin wrappers around two pure
 * functions, `readColorOverrides` / `nextColorOverrides`, exercised directly
 * here (no need to stand up the full DaemonClient/SessionStore/… constellation
 * just to reach `post()` — see `sessionsWebview.logic.test.ts`'s
 * `buildSessionsWebviewModel — colorOverrides` for "a hydrated override map
 * flows into the rendered model", the other half of the round trip).
 */
import type { Memento } from "vscode"
import { describe, expect, it } from "vitest"

import { UNASSIGNED_COLOR_INDEX, workspaceColorFor, WORKSPACE_PALETTE } from "./sessionsWebview.logic.js"
import type { SessionDescriptor, SessionSummary } from "../client/types.js"
import { COLOR_OVERRIDES_KEY, nextColorOverrides, readColorOverrides, visibleRows } from "./sessionsWebviewPanel.js"

/** Minimal in-memory stand-in for `vscode.ExtensionContext.globalState`. */
function fakeMemento(initial: Record<string, unknown> = {}): Memento {
  const store: Record<string, unknown> = { ...initial }
  return {
    get: ((key: string, defaultValue?: unknown) => (key in store ? store[key] : defaultValue)) as Memento["get"],
    update: async (key: string, value: unknown) => {
      store[key] = value
    },
    keys: () => Object.keys(store),
  }
}

describe("readColorOverrides", () => {
  it("returns an empty map when nothing has been persisted yet", () => {
    expect(readColorOverrides(fakeMemento())).toEqual({})
  })
  it("reads back whatever is stored under the color-overrides key", () => {
    const memento = fakeMemento({ [COLOR_OVERRIDES_KEY]: { studio: 3 } })
    expect(readColorOverrides(memento)).toEqual({ studio: 3 })
  })
})

describe("nextColorOverrides", () => {
  it("sets a slug's override", () => {
    expect(nextColorOverrides({}, "studio", 3)).toEqual({ studio: 3 })
  })
  it("resetting (index null) deletes just that slug's entry", () => {
    expect(nextColorOverrides({ studio: 3, other: 5 }, "studio", null)).toEqual({ other: 5 })
  })
  it("resetting an already-unset slug is a no-op delete, not an error", () => {
    expect(nextColorOverrides({ other: 5 }, "studio", null)).toEqual({ other: 5 })
  })
  it("rejects an out-of-range or non-integer index — returns undefined, no map produced", () => {
    expect(nextColorOverrides({ studio: 2 }, "studio", -1)).toBeUndefined()
    expect(nextColorOverrides({ studio: 2 }, "studio", UNASSIGNED_COLOR_INDEX + 1)).toBeUndefined()
    expect(nextColorOverrides({ studio: 2 }, "studio", 1.5)).toBeUndefined()
  })
  it("accepts the neutral unassigned index as a valid override", () => {
    expect(nextColorOverrides({}, "studio", UNASSIGNED_COLOR_INDEX)).toEqual({ studio: UNASSIGNED_COLOR_INDEX })
  })
})

describe("workspace color persistence round-trip (set → persist → hydrate → render)", () => {
  it("a set persists to globalState, and a fresh hydrate (simulating extension reload) reads it back", async () => {
    const memento = fakeMemento()
    expect(readColorOverrides(memento)).toEqual({})

    const afterSet = nextColorOverrides(readColorOverrides(memento), "studio", 3)!
    await memento.update(COLOR_OVERRIDES_KEY, afterSet)

    const rehydrated = readColorOverrides(memento)
    expect(rehydrated).toEqual({ studio: 3 })
  })

  it("reset persists too — a later hydrate sees the override gone", async () => {
    const memento = fakeMemento({ [COLOR_OVERRIDES_KEY]: { studio: 3, other: 5 } })

    const afterReset = nextColorOverrides(readColorOverrides(memento), "studio", null)!
    await memento.update(COLOR_OVERRIDES_KEY, afterReset)

    expect(readColorOverrides(memento)).toEqual({ other: 5 })
  })

  it("the hydrated map flows straight into workspaceColorFor — the render-facing half of the round trip", async () => {
    const memento = fakeMemento()
    const afterSet = nextColorOverrides(readColorOverrides(memento), "studio", 5)!
    await memento.update(COLOR_OVERRIDES_KEY, afterSet)

    const rehydrated = readColorOverrides(memento)
    expect(workspaceColorFor("studio", rehydrated)).toEqual({ index: 5, css: WORKSPACE_PALETTE[5] })
    // An untouched slug still falls back to its hash default through the same map.
    expect(workspaceColorFor("other", rehydrated)).toEqual(workspaceColorFor("other"))
  })
})

describe("visibleRows — render pool == action pool", () => {
  const summary = (id: string, status: SessionSummary["status"]): SessionSummary =>
    ({ id, kind: "agent-cli", workspaceSlug: "ws", command: "claude", pid: 1, status, startedAt: "2026-01-01T00:00:00Z" }) as SessionSummary
  const descriptor = (id: string, status: SessionDescriptor["status"]): SessionDescriptor =>
    summary(id, status) as unknown as SessionDescriptor

  it("pins live store sessions the paginated slice has not reached yet, after pending rows", () => {
    const store = [descriptor("sess_a", "running"), descriptor("sess_b", "exited"), descriptor("sess_c", "running")]
    const loaded = [summary("sess_a", "running"), summary("sess_b", "exited")]
    expect(visibleRows(store, loaded).map(r => r.id)).toEqual(["sess_c", "sess_a", "sess_b"])
  })

  it("dedupes by id so a loaded summary is never doubled by its store twin", () => {
    const store = [descriptor("sess_a", "running")]
    const loaded = [summary("sess_a", "running")]
    expect(visibleRows(store, loaded).map(r => r.id)).toEqual(["sess_a"])
  })

  it("resolves a live extra for an action (the Stop-button regression)", () => {
    // 73 of 191 loaded: a supervisor's still-running child sorts past the
    // slice, is rendered as a live extra with a Stop button, and must be
    // findable by id when that button is clicked.
    const store = [descriptor("sess_child", "running")]
    const loaded: SessionSummary[] = [summary("sess_other", "exited")]
    expect(visibleRows(store, loaded).find(r => r.id === "sess_child")).toBeDefined()
    expect(loaded.find(r => r.id === "sess_child")).toBeUndefined()
  })
})
