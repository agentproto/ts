import { describe, it, expect } from "vitest"
import { cronCreatorOf, isCronCreator } from "../cron-creator.js"
import type { SessionDescriptor, SessionsRegistry } from "../sessions.js"

/** A registry that only answers `get`, with just the fields the creator reads. */
function registryOf(
  rows: ReadonlyArray<{ id: string; kind: "command" | "external" }>,
): Pick<SessionsRegistry, "get"> {
  const byId = new Map(rows.map(row => [row.id, row]))
  return { get: (id: string) => byId.get(id) as unknown as SessionDescriptor | undefined }
}

describe("cronCreatorOf", () => {
  it("no caller is the operator", () => {
    expect(
      cronCreatorOf({
        callerSessionId: undefined,
        callerScopeOwnerId: undefined,
        credentialSessionId: undefined,
        registry: registryOf([]),
      }),
    ).toEqual({ kind: "operator" })
  })

  it("a scope owner is a proven session, whatever the claim says", () => {
    expect(
      cronCreatorOf({
        callerSessionId: "sess_other",
        callerScopeOwnerId: "sess_scope",
        credentialSessionId: undefined,
        registry: registryOf([{ id: "sess_scope", kind: "command" }]),
      }),
    ).toEqual({ kind: "session", sessionId: "sess_scope", proof: "proven" })
  })

  it("a credential equal to the claim is proven", () => {
    expect(
      cronCreatorOf({
        callerSessionId: "sess_c1",
        callerScopeOwnerId: undefined,
        credentialSessionId: "sess_c1",
        registry: registryOf([{ id: "sess_c1", kind: "command" }]),
      }),
    ).toEqual({ kind: "session", sessionId: "sess_c1", proof: "proven" })
  })

  it("a claim without a credential is claimed", () => {
    expect(
      cronCreatorOf({
        callerSessionId: "sess_c2",
        callerScopeOwnerId: undefined,
        credentialSessionId: undefined,
        registry: registryOf([{ id: "sess_c2", kind: "command" }]),
      }),
    ).toEqual({ kind: "session", sessionId: "sess_c2", proof: "claimed" })
  })

  it("a credential for another session is recorded as the claim it was, never as the credential's session", () => {
    expect(
      cronCreatorOf({
        callerSessionId: "sess_d1",
        callerScopeOwnerId: undefined,
        credentialSessionId: "sess_d2",
        registry: registryOf([
          { id: "sess_d1", kind: "command" },
          { id: "sess_d2", kind: "command" },
        ]),
      }),
    ).toEqual({ kind: "session", sessionId: "sess_d1", proof: "claimed" })
  })

  it("an id the registry does not hold is claimed", () => {
    expect(
      cronCreatorOf({
        callerSessionId: "sess_unknown",
        callerScopeOwnerId: undefined,
        credentialSessionId: undefined,
        registry: registryOf([]),
      }),
    ).toEqual({ kind: "session", sessionId: "sess_unknown", proof: "claimed" })
  })

  it("an external row is recorded as external with its id", () => {
    expect(
      cronCreatorOf({
        callerSessionId: "sess_ext",
        callerScopeOwnerId: undefined,
        credentialSessionId: undefined,
        registry: registryOf([{ id: "sess_ext", kind: "external" }]),
      }),
    ).toEqual({ kind: "external", id: "sess_ext" })
  })

  it("never reads a parentSessionId hint: it neither names a creator nor upgrades a claim", () => {
    const withHint = {
      callerSessionId: undefined,
      callerScopeOwnerId: undefined,
      credentialSessionId: undefined,
      registry: registryOf([{ id: "sess_parent", kind: "command" }]),
      parentSessionId: "sess_parent",
    }
    expect(cronCreatorOf(withHint)).toEqual({ kind: "operator" })
    expect(
      cronCreatorOf({ ...withHint, callerSessionId: "sess_parent", credentialSessionId: undefined }),
    ).toEqual({ kind: "session", sessionId: "sess_parent", proof: "claimed" })
  })
})

describe("isCronCreator", () => {
  it("accepts the four forms and refuses anything else", () => {
    expect(isCronCreator({ kind: "operator" })).toBe(true)
    expect(isCronCreator({ kind: "system" })).toBe(true)
    expect(isCronCreator({ kind: "external", id: "x" })).toBe(true)
    expect(isCronCreator({ kind: "session", sessionId: "s", proof: "proven" })).toBe(true)
    expect(isCronCreator({ kind: "session", sessionId: "s", proof: "claimed" })).toBe(true)
    expect(isCronCreator({ kind: "session", sessionId: "s", proof: "none" })).toBe(false)
    expect(isCronCreator({ kind: "session", proof: "proven" })).toBe(false)
    expect(isCronCreator({ kind: "external" })).toBe(false)
    expect(isCronCreator({ kind: "root" })).toBe(false)
    expect(isCronCreator("operator")).toBe(false)
    expect(isCronCreator(null)).toBe(false)
  })
})
