import { describe, expect, it } from "vitest"
import {
  composeMode,
  decomposeMode,
  type DeclaredAdapterMode,
  type SessionConfig,
} from "../session-config.js"

// Mirrors the claude-code manifest's `modes[]` (kind tags added alongside
// this shim) — the real-world fixture decomposeMode/composeMode operate on.
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

describe("decomposeMode", () => {
  it("maps a gateway mode id to the route axis", () => {
    expect(decomposeMode(CLAUDE_CODE_MODES, "moonshot")).toEqual({
      route: { gateway: "moonshot" },
    })
  })

  it("maps a permission mode id to the posture axis", () => {
    expect(decomposeMode(CLAUDE_CODE_MODES, "plan")).toEqual({
      posture: "plan",
    })
  })

  it("maps the lean mode id to the contextProfile axis", () => {
    expect(decomposeMode(CLAUDE_CODE_MODES, "lean")).toEqual({
      contextProfile: "lean",
    })
  })

  it("defaults a truly-unknown id to the contextProfile axis (least-privilege)", () => {
    expect(decomposeMode([], "some-future-adapter-mode")).toEqual({
      contextProfile: "some-future-adapter-mode",
    })
  })

  it("prefers the explicit kind tag over id-based inference", () => {
    // "moonshot" would infer to `route` by id alone — an explicit `kind`
    // tag on the declared mode must win over that inference.
    const modes: DeclaredAdapterMode[] = [{ id: "moonshot", kind: "context" }]
    expect(decomposeMode(modes, "moonshot")).toEqual({
      contextProfile: "moonshot",
    })
  })

  it("infers route/posture from well-known ids when no kind is declared", () => {
    const undeclared: DeclaredAdapterMode[] = [{ id: "moonshot" }, { id: "plan" }]
    expect(decomposeMode(undeclared, "moonshot")).toEqual({
      route: { gateway: "moonshot" },
    })
    expect(decomposeMode(undeclared, "plan")).toEqual({ posture: "plan" })
  })
})

describe("composeMode", () => {
  it("round-trips a route config back to its legacy mode id", () => {
    const decomposed = decomposeMode(CLAUDE_CODE_MODES, "moonshot")
    expect(composeMode(decomposed, CLAUDE_CODE_MODES)).toBe("moonshot")
  })

  it("round-trips a posture config back to its legacy mode id", () => {
    const decomposed = decomposeMode(CLAUDE_CODE_MODES, "plan")
    expect(composeMode(decomposed, CLAUDE_CODE_MODES)).toBe("plan")
  })

  it("round-trips a contextProfile config back to its legacy mode id", () => {
    const decomposed = decomposeMode(CLAUDE_CODE_MODES, "lean")
    expect(composeMode(decomposed, CLAUDE_CODE_MODES)).toBe("lean")
  })

  it("returns undefined when no declared mode matches the config", () => {
    expect(composeMode({ posture: "bypass" }, [{ id: "default", kind: "posture" }])).toBeUndefined()
  })
})

describe("SessionConfig composition", () => {
  it("leaves an explicit config field untouched when overlaid on a decomposed legacy mode", () => {
    const explicit: Partial<SessionConfig> = { model: "claude-opus-4-8", effort: "high" }
    const effective: Partial<SessionConfig> = {
      ...decomposeMode(CLAUDE_CODE_MODES, "plan"),
      ...explicit,
    }
    expect(effective.model).toBe("claude-opus-4-8")
    expect(effective.effort).toBe("high")
    expect(effective.posture).toBe("plan")
  })

  it("an explicit posture is not overwritten by legacy-mode decomposition when merged the other way", () => {
    const explicit: Partial<SessionConfig> = { posture: "read-only" }
    const legacy = decomposeMode(CLAUDE_CODE_MODES, "bypass-permissions")
    const effective: Partial<SessionConfig> = { ...legacy, ...explicit }
    expect(effective.posture).toBe("read-only")
  })
})
