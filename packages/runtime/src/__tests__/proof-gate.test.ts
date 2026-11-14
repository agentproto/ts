import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SessionDescriptor } from "../sessions.js"
import { clearSessionCredentials, mintSessionToken } from "../session-credentials.js"
import {
  claimClassOf,
  decideSpawnProof,
  recordSpawnProof,
  resetSpawnProofObservations,
  spawnGateCallerId,
  spawnProofReport,
} from "../proof-gate.js"

const descriptor = (entry: Partial<SessionDescriptor>): SessionDescriptor =>
  ({ kind: "command", ...entry }) as SessionDescriptor

describe("decideSpawnProof", () => {
  const base = {
    callerKnown: true,
    callerExternal: false,
    scoped: false,
    credentialSessionId: undefined as string | undefined,
  }

  it("no caller id is none", () => {
    expect(decideSpawnProof({ ...base, callerSessionId: undefined })).toBe("none")
  })

  it("a trusted but unknown caller is caller_unknown", () => {
    expect(
      decideSpawnProof({ ...base, callerSessionId: "ghost", callerKnown: false }),
    ).toBe("caller_unknown")
  })

  it("an external caller is external, even with a credential", () => {
    expect(
      decideSpawnProof({
        ...base,
        callerSessionId: "desk",
        callerExternal: true,
        credentialSessionId: "desk",
      }),
    ).toBe("external")
  })

  it("a scoped caller is proven without a credential", () => {
    expect(decideSpawnProof({ ...base, callerSessionId: "orch", scoped: true })).toBe("proven")
  })

  it("a credential naming the caller is proven", () => {
    expect(
      decideSpawnProof({ ...base, callerSessionId: "sess_1", credentialSessionId: "sess_1" }),
    ).toBe("proven")
  })

  it("a credential naming another session is mismatch", () => {
    expect(
      decideSpawnProof({ ...base, callerSessionId: "sess_1", credentialSessionId: "sess_2" }),
    ).toBe("mismatch")
  })

  it("no credential and a known internal caller is claimed", () => {
    expect(decideSpawnProof({ ...base, callerSessionId: "sess_1" })).toBe("claimed")
  })

  it("scope beats a mismatching credential", () => {
    expect(
      decideSpawnProof({
        ...base,
        callerSessionId: "orch",
        scoped: true,
        credentialSessionId: "someone-else",
      }),
    ).toBe("proven")
  })
})

describe("spawnGateCallerId", () => {
  it("prefers the scope owner, then autoParentSessionId, then callerSessionId", () => {
    expect(
      spawnGateCallerId({ ownerSessionId: "scope" }, {
        autoParentSessionId: "auto",
        callerSessionId: "http",
      }),
    ).toBe("scope")
    expect(spawnGateCallerId(undefined, { autoParentSessionId: "auto", callerSessionId: "http" })).toBe("auto")
    expect(spawnGateCallerId(undefined, { callerSessionId: "http" })).toBe("http")
    expect(spawnGateCallerId(undefined, {})).toBeUndefined()
  })
})

describe("claimClassOf", () => {
  beforeEach(() => clearSessionCredentials())
  afterEach(() => clearSessionCredentials())

  it("an unknown id is unknown", () => {
    expect(claimClassOf("ghost", undefined)).toBe("unknown")
  })

  it("an external descriptor is external", () => {
    expect(claimClassOf("desk", descriptor({ kind: "external" }))).toBe("external")
  })

  it("a token-delivered adapter with a live credential is delivered", () => {
    mintSessionToken("sess_1")
    expect(claimClassOf("sess_1", descriptor({ adapterSlug: "claude-code" }))).toBe("delivered")
  })

  it("a token-delivered adapter with no live credential is undelivered", () => {
    expect(claimClassOf("sess_1", descriptor({ adapterSlug: "claude-code" }))).toBe("undelivered")
  })

  it("an adapter that cannot carry a token is undelivered even with a credential", () => {
    mintSessionToken("sess_1")
    expect(claimClassOf("sess_1", descriptor({ adapterSlug: "codex" }))).toBe("undelivered")
  })

  it("a sandboxed or remote placement is undelivered even on a token adapter", () => {
    mintSessionToken("sess_1")
    expect(
      claimClassOf("sess_1", descriptor({ adapterSlug: "claude-code", sandboxId: "box_1" })),
    ).toBe("undelivered")
    expect(
      claimClassOf("sess_1", descriptor({ adapterSlug: "claude-code", remote: true })),
    ).toBe("undelivered")
  })
})

describe("spawn proof observer", () => {
  beforeEach(() => resetSpawnProofObservations())
  afterEach(() => {
    resetSpawnProofObservations()
    vi.restoreAllMocks()
  })

  it("counts every verdict, splits claimed by class and sums wouldRefuse", () => {
    recordSpawnProof("proven", { listed: false, refused: false, surface: "mcp" })
    recordSpawnProof("claimed", {
      listed: false,
      refused: false,
      claimClass: "delivered",
      surface: "mcp",
    })
    recordSpawnProof("claimed", {
      listed: false,
      refused: false,
      claimClass: "undelivered",
      surface: "mcp",
    })
    recordSpawnProof("mismatch", { listed: false, refused: false, surface: "mcp" })
    recordSpawnProof("none", { listed: false, refused: false, surface: "scoped" })

    const report = spawnProofReport([])
    expect(report.counts).toMatchObject({
      proven: 1,
      claimed: 2,
      mismatch: 1,
      none: 1,
      caller_unknown: 0,
      external: 0,
    })
    expect(report.claimedByClass).toEqual({ delivered: 1, undelivered: 1 })
    expect(report.wouldRefuse).toBe(3)
    expect(report.refused).toBe(0)
    expect(report.requireProofIgnored).toBe(0)
    expect(report.requireProof).toEqual([])
    expect(typeof report.since).toBe("string")
  })

  it("counts refusals and ignored listings", () => {
    recordSpawnProof("claimed", {
      listed: true,
      refused: true,
      claimClass: "delivered",
      surface: "mcp",
    })
    recordSpawnProof("mismatch", { listed: true, refused: true, surface: "mcp" })
    recordSpawnProof("claimed", {
      listed: true,
      refused: false,
      claimClass: "delivered",
      surface: "mcp",
      tokensOn: false,
    })

    const report = spawnProofReport(["session:spawn"])
    expect(report.refused).toBe(2)
    expect(report.requireProofIgnored).toBe(1)
    expect(report.requireProof).toEqual(["session:spawn"])
  })

  it("warns once per verdict-and-class pair and never logs a token or credential id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    recordSpawnProof("claimed", {
      listed: false,
      refused: false,
      claimClass: "delivered",
      surface: "mcp",
      callerId: "sess_1",
    })
    recordSpawnProof("claimed", {
      listed: false,
      refused: false,
      claimClass: "delivered",
      surface: "mcp",
      callerId: "sess_2",
    })
    recordSpawnProof("claimed", {
      listed: false,
      refused: false,
      claimClass: "undelivered",
      surface: "scoped",
      callerId: "sess_3",
    })
    expect(warn).toHaveBeenCalledTimes(2)
    const messages = warn.mock.calls.map(call => String(call[0]))
    expect(messages[0]).toContain("[spawn-proof] claimed (class delivered) caller=sess_1 surface mcp")
    expect(messages[1]).toContain("[spawn-proof] claimed (class undelivered) caller=sess_3 surface scoped")
    expect(messages.join("\n")).not.toContain("apst_")
  })

  it("does not warn for the normal traffic: proven, none, external, caller_unknown", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const verdict of ["proven", "none", "external", "caller_unknown"] as const) {
      recordSpawnProof(verdict, { listed: false, refused: false, surface: "mcp", callerId: "sess_1" })
    }
    expect(warn).not.toHaveBeenCalled()
    expect(spawnProofReport([]).counts).toMatchObject({ proven: 1, none: 1, external: 1, caller_unknown: 1 })
  })

  it("warns once for a mismatch reading", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    for (let i = 0; i < 2; i++) {
      recordSpawnProof("mismatch", { listed: false, refused: false, surface: "mcp", callerId: "sess_1" })
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("[spawn-proof] mismatch")
  })

  it("warns once when the list is ignored while tokens are off", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    for (let i = 0; i < 2; i++) {
      recordSpawnProof("claimed", {
        listed: true,
        refused: false,
        claimClass: "delivered",
        surface: "mcp",
        tokensOn: false,
      })
    }
    expect(warn.mock.calls.filter(call => String(call[0]).includes("sessionTokens")).length).toBe(1)
    expect(spawnProofReport(["session:spawn"]).requireProofIgnored).toBe(2)
  })

  it("reset clears every counter and the since clock", () => {
    recordSpawnProof("proven", { listed: false, refused: false, surface: "mcp" })
    resetSpawnProofObservations()
    const report = spawnProofReport([])
    expect(Object.values(report.counts).every(n => n === 0)).toBe(true)
    expect(report.claimedByClass).toEqual({ delivered: 0, undelivered: 0 })
    expect(report.wouldRefuse).toBe(0)
    expect(report.refused).toBe(0)
    expect(report.requireProofIgnored).toBe(0)
  })

  it("no token or credential id appears in the report", () => {
    const token = mintSessionToken("sess_secret")
    recordSpawnProof("claimed", {
      listed: true,
      refused: false,
      claimClass: "delivered",
      surface: "mcp",
      callerId: "sess_secret",
    })
    const serialized = JSON.stringify(spawnProofReport(["session:spawn"]))
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain("credential")
    clearSessionCredentials()
  })
})
