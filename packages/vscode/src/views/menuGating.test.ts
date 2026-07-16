/**
 * Conformance: the sessions view's menus vs the contextValues the tree can
 * actually produce.
 *
 * `when` clauses are strings in package.json — nothing type-checks them against
 * SessionContextValue, so a new contextValue can silently fall into an existing
 * regex. That is exactly what `session-pending` did: three menus matched
 * `/^session-/`, so an optimistic row offered Open Transcript / Open Terminal /
 * raw channel for a session the daemon had never heard of.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import type { SessionContextValue } from "./sessionsTree.logic.js"

interface MenuEntry {
  command: string
  when: string
}

// process.cwd() rather than import.meta.url: check-types compiles this file as
// CJS, which rejects import.meta. vitest runs from the package root.
const pkg: { contributes: { menus: Record<string, MenuEntry[]> } } = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
)

const sessionMenus = pkg.contributes.menus["view/item/context"]!.filter(m =>
  m.when.includes("agentproto.sessions"),
)

/** Does `when` admit this contextValue? Mirrors the two forms in use. */
function admits(when: string, contextValue: SessionContextValue): boolean {
  const equality = /viewItem == ([a-z-]+)/.exec(when)
  if (equality) return equality[1] === contextValue
  const regex = /viewItem =~ \/(.+?)\//.exec(when)
  if (regex) return new RegExp(regex[1]!).test(contextValue)
  return false
}

describe("sessions view menu gating", () => {
  it("offers nothing at all on a pending row", () => {
    // Every action needs a daemon-side id. A pending row has none, so each of
    // these could only 404.
    const offered = sessionMenus.filter(m => admits(m.when, "session-pending")).map(m => m.command)
    expect(offered).toEqual([])
  })

  it("still offers the transcript on real sessions, live or finished", () => {
    // The guard above must not have been bought by gating everything off.
    for (const contextValue of ["session-live", "session-awaiting", "session-done"] as const) {
      const offered = sessionMenus.filter(m => admits(m.when, contextValue)).map(m => m.command)
      expect(offered).toContain("agentproto.openTranscript")
    }
  })

  it("keeps stop off a finished session and restart off a live one", () => {
    const onDone = sessionMenus.filter(m => admits(m.when, "session-done")).map(m => m.command)
    expect(onDone).not.toContain("agentproto.killSession")
    expect(onDone).toContain("agentproto.restartSession")

    const onLive = sessionMenus.filter(m => admits(m.when, "session-live")).map(m => m.command)
    expect(onLive).toContain("agentproto.killSession")
    expect(onLive).not.toContain("agentproto.restartSession")
  })

  it("names every state it admits, so a new contextValue can't fall in by accident", () => {
    // An unanchored /^session-/ is what let `session-pending` through. Any
    // regex here must be anchored at both ends.
    for (const menu of sessionMenus) {
      const regex = /viewItem =~ \/(.+?)\//.exec(menu.when)
      if (!regex) continue
      expect(regex[1], `${menu.command} must anchor its viewItem regex`).toMatch(/^\^.*\$$/)
    }
  })
})
