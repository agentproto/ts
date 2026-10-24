/**
 * AIP-36 shared-box amendment — the `sandbox gc` orphan filter must skip
 * boxes whose ORIGIN session died while OTHER sessions are still attached
 * (their box is not an orphan — the survivors keep it alive). A box whose
 * every attaché is dead or whose survivors' status cannot be observed is
 * filtered exactly as before (dead ⇒ candidate, unknown ⇒ conservative
 * skip). Pure ledger/status selection — never the provider itself.
 */

import { describe, it, expect } from "vitest"
import { collectGcCandidates, type SandboxGcSessionLineage } from "../sandbox-gc.js"
import type { SandboxLedgerEntry } from "../sandbox-ledger.js"

const entryOf = (overrides: Partial<SandboxLedgerEntry>): SandboxLedgerEntry => ({
  sandboxId: "bx_shared",
  provider: "fake",
  state: "paused",
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
  originSessionId: "sess_origin",
  ...overrides,
})

describe("sandbox gc — shared-box survivor filter", () => {
  it("a live survivor keeps the box out of the gc candidates", () => {
    const entry = entryOf({ attachedSessions: ["sess_origin", "sess_survivor"] })
    const statuses = new Map([
      ["sess_origin", "exited"],
      ["sess_survivor", "running"],
    ])
    expect(collectGcCandidates([entry], statuses)).toEqual([])
  })

  it("a box whose every SURVIVING attaché is dead is a gc candidate", () => {
    const entry = entryOf({ attachedSessions: ["sess_origin", "sess_dead_1", "sess_dead_2"] })
    const statuses = new Map([
      ["sess_origin", "exited"],
      ["sess_dead_1", "killed"],
      ["sess_dead_2", "error"],
    ])
    expect(collectGcCandidates([entry], statuses)).toEqual([
      { entry, sessionStatus: "exited" },
    ])
  })

  it("an UNKNOWN survivor status skips the box (conservative)", () => {
    const entry = entryOf({ attachedSessions: ["sess_origin", "sess_mystery"] })
    const statuses = new Map([["sess_origin", "exited"]])
    expect(collectGcCandidates([entry], statuses)).toEqual([])
  })

  it("a LIVE SUCCESSOR resumed onto the box keeps it out of the candidates (2026-10-23 incident shape)", () => {
    // The restart minted sess_successor with `resumedFrom` the dead origin,
    // but never registered it on the ledger: `attachedSessions` is empty and
    // the origin still reads error. The successor's lineage is the only
    // evidence the box is in use, and it must be enough.
    const entry = entryOf({ state: "connected", attachedSessions: [] })
    const statuses = new Map([
      ["sess_origin", "error"],
      ["sess_successor", "running"],
    ])
    const lineage = new Map<string, SandboxGcSessionLineage>([
      ["sess_successor", { resumedFrom: "sess_origin" }],
    ])
    expect(collectGcCandidates([entry], statuses, lineage)).toEqual([])
  })

  it("follows the successor chain through a DEAD intermediate hop to a live grandchild", () => {
    const entry = entryOf({ state: "connected", attachedSessions: [] })
    const statuses = new Map([
      ["sess_origin", "error"],
      ["sess_hop", "killed"],
      ["sess_grandchild", "running"],
    ])
    const lineage = new Map<string, SandboxGcSessionLineage>([
      ["sess_hop", { resumedFrom: "sess_origin" }],
      ["sess_grandchild", { continuedFrom: "sess_hop" }],
    ])
    expect(collectGcCandidates([entry], statuses, lineage)).toEqual([])
  })

  it("an UNKNOWN successor status keeps the box (conservative, like an attaché)", () => {
    const entry = entryOf({ state: "connected", attachedSessions: [] })
    const statuses = new Map([["sess_origin", "exited"]])
    const lineage = new Map<string, SandboxGcSessionLineage>([
      ["sess_successor", { resumedFrom: "sess_origin" }],
    ])
    expect(collectGcCandidates([entry], statuses, lineage)).toEqual([])
  })

  it("a dead origin with only DEAD successors is still a candidate", () => {
    const entry = entryOf({ state: "connected", attachedSessions: [] })
    const statuses = new Map([
      ["sess_origin", "exited"],
      ["sess_successor", "killed"],
    ])
    const lineage = new Map<string, SandboxGcSessionLineage>([
      ["sess_successor", { resumedFrom: "sess_origin" }],
    ])
    expect(collectGcCandidates([entry], statuses, lineage)).toEqual([
      { entry, sessionStatus: "exited" },
    ])
  })

  it("no attachments left at all ⇒ selected exactly as before (regression)", () => {
    const entry = entryOf({ attachedSessions: undefined })
    const statuses = new Map([["sess_origin", "exited"]])
    expect(collectGcCandidates([entry], statuses)).toEqual([
      { entry, sessionStatus: "exited" },
    ])
  })
})
