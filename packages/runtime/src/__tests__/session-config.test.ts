import { describe, expect, it } from "vitest"
import {
  LEGACY_GATEWAY_MODE_IDS,
  LEGACY_POSTURE_MODE_IDS,
} from "@agentproto/driver-agent-cli"
import {
  composeMode,
  decomposeMode,
  type CanonicalPosture,
  type DeclaredAdapterMode,
  type Posture,
  type SessionConfig,
} from "../session-config.js"

// A LEGACY (pre-migration) claude-code `modes[]`, still carrying the old
// posture/route kind tags. As of the SPEC §3.4a route/posture extraction the
// live manifest declares ONLY `kind:"context"` (route → catalog `@route`,
// posture → ACP mode registry), so this fixture no longer mirrors the shipped
// adapter — it is deliberately the OLD shape, because `decomposeMode`/
// `composeMode` must keep classifying these legacy ids for back-compat.
const CLAUDE_CODE_MODES: DeclaredAdapterMode[] = [
  { id: "default", kind: "posture" },
  { id: "lean", kind: "context" },
  { id: "plan", kind: "posture" },
  { id: "accept-edits", kind: "posture" },
  { id: "bypass-permissions", kind: "posture" },
  { id: "moonshot", kind: "route" },
  { id: "openrouter", kind: "route" },
  { id: "requesty", kind: "route" },
  { id: "deepseek", kind: "route" },
]

describe("decomposeMode — each legacy id maps to its correct axis", () => {
  it("maps a gateway mode id to the route axis", () => {
    expect(decomposeMode(CLAUDE_CODE_MODES, "moonshot")).toEqual({
      route: { gateway: "moonshot" },
    })
  })

  it("maps a permission mode id to the posture axis (canonical vocabulary)", () => {
    expect(decomposeMode(CLAUDE_CODE_MODES, "plan")).toEqual({ posture: "plan" })
  })

  it("normalizes an adapter-specific posture id to the canonical superset", () => {
    // bypass-permissions → "bypass"; codex's full-access → "bypass"; build → "default".
    expect(decomposeMode(CLAUDE_CODE_MODES, "bypass-permissions")).toEqual({
      posture: "bypass",
    })
    expect(decomposeMode([{ id: "full-access", kind: "posture" }], "full-access")).toEqual({
      posture: "bypass",
    })
    expect(decomposeMode([{ id: "build", kind: "posture" }], "build")).toEqual({
      posture: "default",
    })
  })

  it("maps the lean mode id to the contextProfile axis", () => {
    expect(decomposeMode(CLAUDE_CODE_MODES, "lean")).toEqual({ contextProfile: "lean" })
  })

  it("defaults a truly-unknown id to contextProfile (least-privilege, SPEC R4)", () => {
    expect(decomposeMode([], "some-future-adapter-mode")).toEqual({
      contextProfile: "some-future-adapter-mode",
    })
  })

  it("prefers the explicit kind tag over id-based inference", () => {
    // "moonshot" would infer to `route` by id alone — an explicit `kind` tag
    // on the declared mode must win over that inference.
    const modes: DeclaredAdapterMode[] = [{ id: "moonshot", kind: "context" }]
    expect(decomposeMode(modes, "moonshot")).toEqual({ contextProfile: "moonshot" })
  })

  it("infers route/posture from well-known ids when no kind is declared", () => {
    const undeclared: DeclaredAdapterMode[] = [{ id: "moonshot" }, { id: "plan" }]
    expect(decomposeMode(undeclared, "moonshot")).toEqual({ route: { gateway: "moonshot" } })
    expect(decomposeMode(undeclared, "plan")).toEqual({ posture: "plan" })
  })

  it("never yields a { harnessModeId } posture — the shim speaks canonical only", () => {
    const decomposed = decomposeMode(CLAUDE_CODE_MODES, "plan")
    // A CanonicalPosture is a string; a raw harness mode would be an object.
    expect(typeof decomposed.posture).toBe("string")
  })

  // Drift guard: the legacy route/posture id sets are single-sourced in
  // `@agentproto/driver-agent-cli` (`legacy-modes.ts`) and reused by both this
  // shim and the driver's `composeSpawn` back-compat path. Assert `decomposeMode`
  // stays consistent with that shared classification — every gateway id ⇒ route,
  // every posture id ⇒ a canonical posture — so the two sides can't diverge.
  it.each([...LEGACY_GATEWAY_MODE_IDS])(
    "classifies the shared gateway id '%s' as the route axis (no kind tag)",
    id => {
      expect(decomposeMode([], id)).toEqual({ route: { gateway: id } })
    }
  )

  it.each([...LEGACY_POSTURE_MODE_IDS])(
    "classifies the shared posture id '%s' as a canonical posture (no kind tag)",
    id => {
      const decomposed = decomposeMode([], id)
      expect(decomposed.route).toBeUndefined()
      expect(decomposed.contextProfile).toBeUndefined()
      expect(typeof decomposed.posture).toBe("string")
    }
  )
})

describe("composeMode — lossless round-trip on a SINGLE decomposed axis (SPEC §3.8)", () => {
  it("round-trips every declared mode id through decompose → compose", () => {
    // The authoritative invariant: for each legacy id, decomposing then
    // recomposing returns the same id (lossless on one axis).
    for (const mode of CLAUDE_CODE_MODES) {
      const decomposed = decomposeMode(CLAUDE_CODE_MODES, mode.id)
      expect(composeMode(decomposed, CLAUDE_CODE_MODES)).toBe(mode.id)
    }
  })

  it("returns undefined when no declared mode matches the config", () => {
    expect(composeMode({ posture: "bypass" }, [{ id: "default", kind: "posture" }])).toBeUndefined()
  })

  it("returns undefined for a raw { harnessModeId } posture — no legacy id represents it", () => {
    const cfg: Partial<SessionConfig> = { posture: { harnessModeId: "some-native-mode" } }
    expect(composeMode(cfg, CLAUDE_CODE_MODES)).toBeUndefined()
  })
})

describe("composeMode is LOSSY — documented single-string limitation (SPEC §3.8)", () => {
  it("cannot represent an orthogonal posture+route combination in one legacy id", () => {
    const compound: Partial<SessionConfig> = {
      posture: "plan",
      route: { gateway: "moonshot" },
    }
    const composed = composeMode(compound, CLAUDE_CODE_MODES)
    // composeMode yields at most ONE legacy mode id, so it structurally cannot
    // carry both axes — decomposing the result recovers only one of them.
    expect(typeof composed).toBe("string")
    if (typeof composed !== "string") return
    const roundTripped = decomposeMode(CLAUDE_CODE_MODES, composed)
    expect(roundTripped).not.toEqual(compound) // an axis was dropped — lossy
  })
})

describe("SessionConfig axis composition (explicit fields win over legacy mode)", () => {
  it("leaves explicit config fields untouched when overlaid on a decomposed legacy mode", () => {
    const explicit: Partial<SessionConfig> = { model: "claude-opus-4-8", effort: "high" }
    const effective: Partial<SessionConfig> = {
      ...decomposeMode(CLAUDE_CODE_MODES, "plan"),
      ...explicit,
    }
    expect(effective.model).toBe("claude-opus-4-8")
    expect(effective.effort).toBe("high")
    expect(effective.posture).toBe("plan")
  })

  it("an explicit posture is not overwritten by legacy-mode decomposition", () => {
    const explicit: Partial<SessionConfig> = { posture: "read-only" }
    const legacy = decomposeMode(CLAUDE_CODE_MODES, "bypass-permissions")
    const effective: Partial<SessionConfig> = { ...legacy, ...explicit }
    expect(effective.posture).toBe("read-only")
  })
})

describe("harness axis", () => {
  it("is part of SessionConfig", () => {
    const cfg: SessionConfig = {
      harness: "claude-code",
      model: "claude-sonnet-4",
    }
    expect(cfg.harness).toBe("claude-code")
  })
})

describe("Posture type — canonical | { harnessModeId } (SPEC §3.1/§3.4a)", () => {
  it("accepts both a canonical posture and a raw harness mode id", () => {
    const canonical: Posture = "plan"
    const native: Posture = { harnessModeId: "architect" }
    // Discriminate the two arms the way a consumer (chip/descriptor) would.
    expect(typeof canonical).toBe("string")
    expect(typeof native === "object" && native.harnessModeId).toBe("architect")
  })

  it("CanonicalPosture is a subtype of Posture", () => {
    const c: CanonicalPosture = "accept-edits"
    const p: Posture = c
    expect(p).toBe("accept-edits")
  })
})
