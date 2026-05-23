/**
 * Attestation chain + access policy + capability levels.
 */

import { describe, expect, it } from "vitest"
import {
  appendAttestation,
  evaluateAccess,
  evaluateCapability,
  makeAttestation,
  readAccessSpec,
  readAccessModes,
  readAttestations,
} from "../index.js"
import type { Attestation } from "../types.js"

// ── Attestation chain ────────────────────────────────────────────────

describe("appendAttestation / readAttestations (M10)", () => {
  it("appends to an empty frontmatter (creates metadata.corpus.attestations)", () => {
    const att = makeAttestation({
      kind: "created",
      identity: "ws://operators/scout",
      at: "2026-05-22T14:30:00Z",
    })
    const out = appendAttestation({}, att)
    expect(readAttestations(out)).toEqual([att])
  })

  it("preserves existing attestations + appends", () => {
    const a1 = makeAttestation({
      kind: "created",
      identity: "ws://operators/scout",
      at: "2026-05-22T14:30:00Z",
    })
    const a2 = makeAttestation({
      kind: "analyzed",
      identity: "ws://operators/analyst",
      at: "2026-05-22T15:00:00Z",
    })
    let fm = appendAttestation({}, a1)
    fm = appendAttestation(fm, a2)
    expect(readAttestations(fm)).toEqual([a1, a2])
  })

  it("is idempotent on duplicate (same kind + identity + at)", () => {
    const a = makeAttestation({
      kind: "created",
      identity: "ws://operators/scout",
      at: "2026-05-22T14:30:00Z",
    })
    let fm = appendAttestation({}, a)
    fm = appendAttestation(fm, a)
    expect(readAttestations(fm).length).toBe(1)
  })

  it("preserves other metadata.corpus fields", () => {
    const a = makeAttestation({
      kind: "promoted",
      identity: "x",
      at: "t",
    })
    const fm = appendAttestation(
      { slug: "foo", metadata: { corpus: { qualityScore: 4.5 } } },
      a
    )
    const meta = fm.metadata as {
      corpus: { qualityScore: number; attestations: Attestation[] }
    }
    expect(meta.corpus.qualityScore).toBe(4.5)
    expect(meta.corpus.attestations.length).toBe(1)
  })
})

// ── Access policy ────────────────────────────────────────────────────

describe("evaluateAccess (M10)", () => {
  const callerSarah = {
    identityTree: [
      "ws://operators/sarah",
      "ws://roles/marketing-analyst",
      "ws://guilds/acme-marketing",
      "ws://orgs/acme-corp",
    ],
  }
  const callerBob = {
    identityTree: [
      "ws://operators/bob",
      "ws://roles/sales-rep",
      "ws://guilds/acme-sales",
      "ws://orgs/acme-corp",
    ],
  }
  const callerOutsider = {
    identityTree: ["ws://users/outsider"],
  }

  // The marketing corpus's home guild — passed by the adapter at
  // evaluation time. Without it, `internal` fails closed (deliberate
  // — an unidentifiable workspace shouldn't leak via the broadest
  // classification).
  const marketingCtx = { homeGuild: "acme-marketing" }

  it("undefined spec → internal default (caller in workspace's home guild = permit)", () => {
    expect(
      evaluateAccess(undefined, callerSarah, marketingCtx).permitted
    ).toBe(true)
    expect(
      evaluateAccess(undefined, callerOutsider, marketingCtx).permitted
    ).toBe(false)
  })

  it("public = anyone", () => {
    const d = evaluateAccess(
      { classification: "public" },
      callerOutsider,
      marketingCtx
    )
    expect(d.permitted).toBe(true)
    expect(d.redactBytes).toBe(false)
  })

  it("internal = home-guild OK, sibling-guild rejected, outsider rejected", () => {
    expect(
      evaluateAccess(
        { classification: "internal" },
        callerSarah,
        marketingCtx
      ).permitted
    ).toBe(true)
    // Bob is in the same org but a different guild — internal must
    // NOT leak across guilds even within the same org.
    expect(
      evaluateAccess(
        { classification: "internal" },
        callerBob,
        marketingCtx
      ).permitted
    ).toBe(false)
    expect(
      evaluateAccess(
        { classification: "internal" },
        callerOutsider,
        marketingCtx
      ).permitted
    ).toBe(false)
  })

  it("internal fails closed when no homeGuild context is supplied", () => {
    // An adapter that didn't thread `accessContext` (e.g. standalone
    // test fixture) shouldn't accidentally permit internal content.
    expect(
      evaluateAccess({ classification: "internal" }, callerSarah).permitted
    ).toBe(false)
  })

  it("restricted denies by default; explicit allow list overrides", () => {
    expect(
      evaluateAccess({ classification: "restricted" }, callerSarah).permitted
    ).toBe(false)
    expect(
      evaluateAccess(
        {
          classification: "restricted",
          allowedOperators: ["sarah"],
        },
        callerSarah
      ).permitted
    ).toBe(true)
  })

  it("secret + no allow list → permit=false + redactBytes=true", () => {
    const d = evaluateAccess({ classification: "secret" }, callerSarah)
    expect(d.permitted).toBe(false)
    expect(d.redactBytes).toBe(true)
  })

  it("secret + matching role in allow list → permit=true", () => {
    const d = evaluateAccess(
      {
        classification: "secret",
        allowedRoles: ["marketing-analyst"],
      },
      callerSarah
    )
    expect(d.permitted).toBe(true)
  })

  it("guild-scoped allow list permits same-guild caller", () => {
    expect(
      evaluateAccess(
        {
          classification: "restricted",
          allowedGuilds: ["acme-marketing"],
        },
        callerSarah
      ).permitted
    ).toBe(true)
    expect(
      evaluateAccess(
        {
          classification: "restricted",
          allowedGuilds: ["acme-marketing"],
        },
        callerBob
      ).permitted
    ).toBe(false)
  })

  it("ws://roles/* glob matches any role in caller tree", () => {
    expect(
      evaluateAccess(
        {
          classification: "restricted",
          allowedRoles: ["ws://roles/*"],
        },
        callerSarah
      ).permitted
    ).toBe(true)
    expect(
      evaluateAccess(
        {
          classification: "restricted",
          allowedRoles: ["ws://roles/*"],
        },
        callerOutsider // no role in tree
      ).permitted
    ).toBe(false)
  })

  it("readAccessSpec extracts from metadata.corpus.access", () => {
    const fm = {
      slug: "x",
      metadata: {
        corpus: {
          access: { classification: "restricted", allowedRoles: ["legal"] },
        },
      },
    }
    expect(readAccessSpec(fm)).toEqual({
      classification: "restricted",
      allowedRoles: ["legal"],
    })
    expect(readAccessSpec({})).toBeUndefined()
  })
})

// ── Capability levels ──────────────────────────────────────────────

describe("evaluateCapability (M10)", () => {
  const operatorAny = {
    identityTree: [
      "ws://operators/sarah",
      "ws://roles/marketing-analyst",
      "ws://guilds/acme-marketing",
    ],
  }
  const curator = {
    identityTree: [
      "ws://operators/curator-bot",
      "ws://roles/corpus-curator",
      "ws://guilds/acme-marketing",
    ],
  }
  const admin = {
    identityTree: [
      "ws://operators/admin-bot",
      "ws://roles/admin",
      "ws://guilds/acme-marketing",
    ],
  }

  it("read is permitted for any operator (default *)", () => {
    expect(evaluateCapability("read", undefined, operatorAny).permitted).toBe(true)
  })

  it("curate requires corpus-curator or admin", () => {
    expect(evaluateCapability("curate", undefined, operatorAny).permitted).toBe(false)
    expect(evaluateCapability("curate", undefined, curator).permitted).toBe(true)
    expect(evaluateCapability("curate", undefined, admin).permitted).toBe(true)
  })

  it("activate-playbook requires curator/admin AND requireApproval=true", () => {
    const d = evaluateCapability("activate-playbook", undefined, curator)
    expect(d.permitted).toBe(true)
    expect(d.requireApproval).toBe(true)
  })

  it("admin-reindex requires admin role", () => {
    expect(
      evaluateCapability("admin-reindex", undefined, operatorAny).permitted
    ).toBe(false)
    expect(
      evaluateCapability("admin-reindex", undefined, curator).permitted
    ).toBe(false)
    expect(evaluateCapability("admin-reindex", undefined, admin).permitted).toBe(true)
  })

  it("bypass-default-filters allows curator + flags audit=true", () => {
    const d = evaluateCapability("bypass-default-filters", undefined, curator)
    expect(d.permitted).toBe(true)
    expect(d.audit).toBe(true)
  })

  it("flag-learning surfaces rateLimit hint", () => {
    const d = evaluateCapability("flag-learning", undefined, operatorAny)
    expect(d.permitted).toBe(true)
    expect(d.rateLimit?.perOperator).toBe(20)
    expect(d.rateLimit?.window).toBe("24h")
  })

  it("workspace override beats default", () => {
    const am = {
      curate: { allowedRoles: ["marketing-analyst"] }, // wide-open
    } as const
    expect(evaluateCapability("curate", am, operatorAny).permitted).toBe(true)
  })

  it("readAccessModes pulls from KNOWLEDGE.md.metadata.corpus.accessModes", () => {
    const fm = {
      metadata: {
        corpus: { accessModes: { read: { allowedRoles: ["x"] } } },
      },
    }
    expect(readAccessModes(fm)?.read?.allowedRoles).toEqual(["x"])
  })
})
