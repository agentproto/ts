/**
 * AIP-36 shared-box amendment — the `sandbox gc` orphan filter must skip
 * boxes whose ORIGIN session died while OTHER sessions are still attached
 * (their box is not an orphan — the survivors keep it alive). A box whose
 * every attaché is dead or whose survivors' status cannot be observed is
 * filtered exactly as before (dead ⇒ candidate, unknown ⇒ conservative
 * skip). Pure ledger/status selection — never the provider itself.
 */

import { describe, it, expect } from "vitest"
import { collectGcCandidates } from "../sandbox-gc.js"
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

  it("no attachments left at all ⇒ selected exactly as before (regression)", () => {
    const entry = entryOf({ attachedSessions: undefined })
    const statuses = new Map([["sess_origin", "exited"]])
    expect(collectGcCandidates([entry], statuses)).toEqual([
      { entry, sessionStatus: "exited" },
    ])
  })
})
