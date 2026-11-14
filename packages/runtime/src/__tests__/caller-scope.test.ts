/**
 * The caller scope (`caller-scope.ts`): who a call is, from the CALLER
 * session's ground (AIP-34 §Node scope of a session). Missing or unknown
 * identity is refused, a host call stays a host call, a ground in no declared
 * tree has no node scope. Uses the one shared fixture; nothing under
 * ~/.agentproto.
 */

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  CALLER_NODE_HEADER,
  CALLER_SESSION_HEADER,
  CallerRefusedError,
  CallerScopes,
  HOST_CALLER,
  assertServed,
  callerHeaders,
  memoryScopeOf,
  nodeVisibleToCaller,
  type CallerScope,
} from "../caller-scope.js"
import { NOTES_ID, PERSO_ID, SESSION, USER_ROOT_ID, buildCallerFixture, declare, type CallerFixture } from "./caller-scope-fixture.js"

let fx: CallerFixture
beforeEach(() => {
  fx = buildCallerFixture()
})
afterEach(() => fx.cleanup())

function session(c: CallerScope) {
  if (c.kind !== "session") throw new Error(`expected a session caller, got ${c.kind}`)
  return c
}

describe("resolve", () => {
  it("a call with no caller session is a host call", () => {
    expect(fx.caller(undefined)).toEqual({ kind: "host" })
    expect(fx.caller("")).toEqual({ kind: "host" })
  })

  it("a caller id the daemon does not know is refused, never served unscoped", () => {
    const c = fx.caller(SESSION.ghost)
    expect(c.kind).toBe("refused")
    expect(() => assertServed(c)).toThrow(CallerRefusedError)
  })

  it("a missing caller object is refused like a refused one", () => {
    expect(() => assertServed(undefined)).toThrow(CallerRefusedError)
  })

  it("derives the node scope from the session's ground, not from anything else", () => {
    expect(session(fx.caller(SESSION.perso)).node?.node.id).toBe(PERSO_ID)
    expect(session(fx.caller(SESSION.notes)).node?.node.id).toBe(NOTES_ID)
    expect(session(fx.caller(SESSION.userRoot)).node?.node.id).toBe(USER_ROOT_ID)
  })

  it("cuts the projection after the sealed node", () => {
    const perso = session(fx.caller(SESSION.perso))
    expect(perso.node?.projection.map((n) => n.id)).toEqual([PERSO_ID])
    const notes = session(fx.caller(SESSION.notes))
    expect(notes.node?.projection.map((n) => n.id)).toEqual([NOTES_ID, USER_ROOT_ID])
  })

  it("a session whose ground lies in no declared tree has no node scope", () => {
    const c = session(fx.caller(SESSION.free))
    expect(c.node).toBeUndefined()
  })

  it("a session with no ground has no node scope", () => {
    fx.sessions.byId.set("sess_external", {})
    expect(session(fx.caller("sess_external")).node).toBeUndefined()
  })

  it("a ground the tree cannot place (relative path) is refused, never served unscoped", () => {
    fx.sessions.byId.set("sess_rel", { cwd: "perso/journal" })
    expect(fx.caller("sess_rel").kind).toBe("refused")
  })

  it("an unreadable tree is refused", () => {
    writeFileSync(join(fx.user.notes, "WORKSPACE.md"), "---\nschema: workspace/v2\nid: not-a-valid-id\n---\n")
    expect(fx.caller(SESSION.notes).kind).toBe("refused")
  })

  it("a symlink inside a node cannot make a ground look like it lies in another node", () => {
    const link = join(fx.user.notes, "link-to-perso")
    symlinkSync(fx.user.perso, link)
    fx.sessions.byId.set("sess_link", { cwd: link })
    expect(session(fx.caller("sess_link")).node?.node.id).toBe(PERSO_ID)
  })

  it("rereads a tree after the TTL, not before", () => {
    let now = 1_000
    const scopes = new CallerScopes({ treeTtlMs: 5_000, now: () => now })
    const before = scopes.ofSession({ sessionId: "s", ground: fx.user.notes })
    expect(session(before).node?.node.wall).toBe("isolated")
    declare(fx.user.notes, NOTES_ID, "company", { wall: "sealed" })
    expect(session(scopes.ofSession({ sessionId: "s", ground: fx.user.notes })).node?.node.wall).toBe("isolated")
    now += 5_001
    expect(session(scopes.ofSession({ sessionId: "s", ground: fx.user.notes })).node?.node.wall).toBe("sealed")
  })
})

describe("memoryScopeOf", () => {
  it("is undefined for a host call", () => {
    expect(memoryScopeOf(HOST_CALLER)).toBeUndefined()
  })

  it("throws for a refused caller", () => {
    expect(() => memoryScopeOf(fx.caller(SESSION.ghost))).toThrow(CallerRefusedError)
  })

  it("hands the store the cut projection, the tree root and the operator anchor", () => {
    expect(memoryScopeOf(fx.caller(SESSION.notes))).toEqual({
      nodes: [NOTES_ID, USER_ROOT_ID],
      tree: USER_ROOT_ID,
      operator: "jeremy",
    })
    expect(memoryScopeOf(fx.caller(SESSION.perso))).toEqual({
      nodes: [PERSO_ID],
      tree: USER_ROOT_ID,
      operator: "jeremy",
    })
  })

  it("a session with no node scope still gets a scope with an empty projection, like the spawn digest", () => {
    expect(memoryScopeOf(fx.caller(SESSION.free))).toEqual({ nodes: [] })
  })
})

describe("nodeVisibleToCaller", () => {
  function visible(callerId: string, path: string): boolean {
    const c = session(fx.caller(callerId))
    const located = fx.scopes.locate(path)
    if (!c.node || !located) throw new Error("fixture path must be inside a node")
    return nodeVisibleToCaller(c.node, located)
  }

  it("a session sees its own node and, below it, a plain folder", () => {
    expect(visible(SESSION.perso, fx.user.perso)).toBe(true)
    expect(visible(SESSION.perso, fx.user.persoJournal)).toBe(true)
  })

  it("a sealed node's items are absent for its sibling", () => {
    expect(visible(SESSION.notes, fx.user.perso)).toBe(false)
  })

  it("an item above the sealed wall is absent for the sealed node", () => {
    expect(visible(SESSION.perso, fx.user.root)).toBe(false)
    expect(visible(SESSION.perso, fx.user.notes)).toBe(false)
  })

  it("an ancestor loses sight of a sealed descendant but keeps an isolated one", () => {
    expect(visible(SESSION.userRoot, fx.user.perso)).toBe(false)
    expect(visible(SESSION.userRoot, fx.user.notes)).toBe(true)
  })

  it("an isolated sibling's ancestor chain is visible to it, a different tree never is", () => {
    expect(visible(SESSION.notes, fx.user.root)).toBe(true)
    expect(visible(SESSION.agentik, fx.user.notes)).toBe(false)
    expect(visible(SESSION.notes, fx.company.agentik)).toBe(false)
  })
})

describe("pathVisible", () => {
  it("a host call and a session with no node scope see every path", () => {
    expect(fx.scopes.pathVisible(HOST_CALLER, fx.user.perso)).toBe(true)
    expect(fx.scopes.pathVisible(fx.caller(SESSION.free), fx.user.perso)).toBe(true)
  })

  it("a path outside every declared tree is not walled", () => {
    expect(fx.scopes.pathVisible(fx.caller(SESSION.perso), join(fx.free, "free.txt"))).toBe(true)
  })

  it("a path not yet created inside a sealed node is still that node's", () => {
    expect(fx.scopes.pathVisible(fx.caller(SESSION.notes), join(fx.user.perso, "new", "file.txt"))).toBe(false)
  })

  it("a recursive target holding a sealed node is not visible to its ancestor", () => {
    const c = fx.caller(SESSION.userRoot)
    expect(fx.scopes.pathVisible(c, fx.user.root)).toBe(true)
    expect(fx.scopes.pathVisible(c, fx.user.root, { subtree: true })).toBe(false)
    expect(fx.scopes.pathVisible(c, fx.user.notes, { subtree: true })).toBe(true)
  })

  it("a refused or missing caller sees nothing", () => {
    expect(fx.scopes.pathVisible(fx.caller(SESSION.ghost), fx.free)).toBe(false)
    expect(fx.scopes.pathVisible(undefined, fx.free)).toBe(false)
  })
})

describe("callerHeaders", () => {
  it("a host call forwards nothing", () => {
    expect(callerHeaders(HOST_CALLER)).toBeUndefined()
  })

  it("a session forwards its id and, when it has one, its node", () => {
    expect(callerHeaders(fx.caller(SESSION.perso))).toEqual({
      [CALLER_SESSION_HEADER]: SESSION.perso,
      [CALLER_NODE_HEADER]: PERSO_ID,
    })
    expect(callerHeaders(fx.caller(SESSION.free))).toEqual({ [CALLER_SESSION_HEADER]: SESSION.free })
  })

  it("names the two headers", () => {
    expect(CALLER_SESSION_HEADER).toBe("x-agentproto-caller-session")
    expect(CALLER_NODE_HEADER).toBe("x-agentproto-caller-node")
  })
})

describe("no WORKSPACE.md declared anywhere", () => {
  it("every session has no node scope and every path is visible", () => {
    const sessions = fx.sessions
    sessions.byId.set("sess_plain", { cwd: fx.free })
    const c = fx.scopes.resolve("sess_plain", sessions)
    expect(session(c).node).toBeUndefined()
    expect(fx.scopes.pathVisible(c, join(fx.free, "free.txt"))).toBe(true)
    mkdirSync(join(fx.free, "sub"), { recursive: true })
    expect(fx.scopes.pathVisible(c, join(fx.free, "sub"), { subtree: true })).toBe(true)
  })
})
