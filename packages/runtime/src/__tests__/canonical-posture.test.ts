import { describe, expect, it } from "vitest"
import type { SessionMode } from "@agentproto/acp/client"
import {
  canonicalForModeId,
  findNativeMode,
  normalizeModeId,
  POSTURE_NATIVE_ALIASES,
  POSTURE_PREAMBLES,
  resolvePosture,
} from "../canonical-posture.js"
import type { CanonicalPosture, Posture } from "../session-config.js"

const mode = (id: string, name = id): SessionMode => ({ id, name })

// claude-code's ACP wrapper advertises its permission modes with the SDK's own
// camelCase spelling (`adapters/claude-code/src/index.ts:216,223`), which differs
// from the hyphenated manifest posture ids — the exact casing skew the alias map
// is built to absorb.
const CLAUDE_CODE_MODES: SessionMode[] = [
  mode("default", "Default"),
  mode("plan", "Plan"),
  mode("acceptEdits", "Accept Edits"),
  mode("bypassPermissions", "Bypass Permissions"),
]

// A harness that advertises NO native mode registry (e.g. hermes,
// `agent-tools.ts:280-282`) — every canonical posture must fall through to
// prompt-injection here.
const NO_MODES: SessionMode[] = []

describe("normalizeModeId — casing/separator-insensitive matching", () => {
  it("collapses casing and separators to one canonical spelling", () => {
    expect(normalizeModeId("acceptEdits")).toBe("acceptedits")
    expect(normalizeModeId("accept-edits")).toBe("acceptedits")
    expect(normalizeModeId("Accept_Edits")).toBe("acceptedits")
    expect(normalizeModeId("bypass-permissions")).toBe("bypasspermissions")
    expect(normalizeModeId("bypassPermissions")).toBe("bypasspermissions")
  })
})

describe("POSTURE_NATIVE_ALIASES / canonicalForModeId — the canonical↔native map", () => {
  it("maps every harness spelling of a posture to the same canonical id", () => {
    expect(canonicalForModeId("acceptEdits")).toBe("accept-edits")
    expect(canonicalForModeId("accept-edits")).toBe("accept-edits")
    expect(canonicalForModeId("bypassPermissions")).toBe("bypass")
    expect(canonicalForModeId("bypass-permissions")).toBe("bypass")
    // codex's full-access and opencode's build normalize into the superset,
    // mirroring session-config.ts's POSTURE_MODE_VALUES.
    expect(canonicalForModeId("full-access")).toBe("bypass")
    expect(canonicalForModeId("build")).toBe("default")
    expect(canonicalForModeId("plan")).toBe("plan")
    expect(canonicalForModeId("read-only")).toBe("read-only")
  })

  it("returns undefined for a harness-specific mode the vocabulary doesn't name", () => {
    expect(canonicalForModeId("architect")).toBeUndefined()
    expect(canonicalForModeId("some-future-mode")).toBeUndefined()
  })

  it("aliases are disjoint across postures (canonicalForModeId is unambiguous)", () => {
    const seen = new Map<string, CanonicalPosture>()
    for (const [posture, aliases] of Object.entries(POSTURE_NATIVE_ALIASES) as [
      CanonicalPosture,
      readonly string[],
    ][]) {
      for (const alias of aliases) {
        const norm = normalizeModeId(alias)
        expect(seen.has(norm)).toBe(false)
        seen.set(norm, posture)
      }
    }
  })

  it("every canonical posture has at least one native alias", () => {
    const postures: CanonicalPosture[] = ["default", "plan", "accept-edits", "bypass", "read-only"]
    for (const p of postures) expect(POSTURE_NATIVE_ALIASES[p].length).toBeGreaterThan(0)
  })
})

describe("POSTURE_PREAMBLES — the prompt-injection fallback text", () => {
  it("supplies a non-empty preamble for every non-default posture", () => {
    const nonDefault: Exclude<CanonicalPosture, "default">[] = [
      "plan",
      "accept-edits",
      "bypass",
      "read-only",
    ]
    for (const p of nonDefault) {
      expect(POSTURE_PREAMBLES[p].length).toBeGreaterThan(0)
    }
  })

  it("plan preamble forbids edits; bypass preamble warns about no prompts", () => {
    expect(POSTURE_PREAMBLES.plan.toUpperCase()).toContain("PLAN")
    expect(POSTURE_PREAMBLES.plan.toLowerCase()).toContain("do not")
    expect(POSTURE_PREAMBLES.bypass.toUpperCase()).toContain("BYPASS")
    expect(POSTURE_PREAMBLES["read-only"].toUpperCase()).toContain("READ-ONLY")
  })
})

describe("findNativeMode — locate the advertised mode that enforces a posture", () => {
  it("matches a canonical posture to a harness mode across casing skew", () => {
    expect(findNativeMode("accept-edits", CLAUDE_CODE_MODES)?.id).toBe("acceptEdits")
    expect(findNativeMode("bypass", CLAUDE_CODE_MODES)?.id).toBe("bypassPermissions")
    expect(findNativeMode("plan", CLAUDE_CODE_MODES)?.id).toBe("plan")
    expect(findNativeMode("default", CLAUDE_CODE_MODES)?.id).toBe("default")
  })

  it("returns undefined when no advertised mode matches", () => {
    expect(findNativeMode("read-only", CLAUDE_CODE_MODES)).toBeUndefined()
    expect(findNativeMode("plan", NO_MODES)).toBeUndefined()
  })

  it("resolves a raw { harnessModeId } against the advertised registry", () => {
    const posture: Posture = { harnessModeId: "acceptEdits" }
    expect(findNativeMode(posture, CLAUDE_CODE_MODES)?.id).toBe("acceptEdits")
    // separator-insensitive: the manifest hyphenated spelling still resolves.
    expect(findNativeMode({ harnessModeId: "accept-edits" }, CLAUDE_CODE_MODES)?.id).toBe(
      "acceptEdits",
    )
  })
})

describe("resolvePosture — native enforcement vs prompt-injection fallback (SPEC §3.4a)", () => {
  it("resolves to NATIVE when the harness advertises an equivalent mode", () => {
    const r = resolvePosture("plan", CLAUDE_CODE_MODES)
    expect(r.kind).toBe("native")
    if (r.kind !== "native") return
    expect(r.mode.id).toBe("plan")
  })

  it("prefers native enforcement over the preamble when both could apply", () => {
    // bypass has both a native mode here AND a preamble — native must win.
    const r = resolvePosture("bypass", CLAUDE_CODE_MODES)
    expect(r.kind).toBe("native")
  })

  it("falls back to PROMPT-injection when no native mode exists", () => {
    const r = resolvePosture("plan", NO_MODES)
    expect(r.kind).toBe("prompt")
    if (r.kind !== "prompt") return
    expect(r.posture).toBe("plan")
    expect(r.preamble).toBe(POSTURE_PREAMBLES.plan)
  })

  it("prompt-injects read-only even on claude-code (no native read-only mode)", () => {
    const r = resolvePosture("read-only", CLAUDE_CODE_MODES)
    expect(r.kind).toBe("prompt")
    if (r.kind !== "prompt") return
    expect(r.preamble).toBe(POSTURE_PREAMBLES["read-only"])
  })

  it("default resolves to NOOP when the harness has no native default mode", () => {
    const r = resolvePosture("default", NO_MODES)
    expect(r).toEqual({ kind: "noop", posture: "default" })
  })

  it("default still resolves to NATIVE when the harness advertises one", () => {
    const r = resolvePosture("default", CLAUDE_CODE_MODES)
    expect(r.kind).toBe("native")
    if (r.kind !== "native") return
    expect(r.mode.id).toBe("default")
  })

  it("a raw { harnessModeId } resolves native when advertised", () => {
    const r = resolvePosture({ harnessModeId: "bypassPermissions" }, CLAUDE_CODE_MODES)
    expect(r.kind).toBe("native")
    if (r.kind !== "native") return
    expect(r.mode.id).toBe("bypassPermissions")
  })

  it("a raw { harnessModeId } no longer advertised resolves UNAVAILABLE (no preamble)", () => {
    const r = resolvePosture({ harnessModeId: "architect" }, CLAUDE_CODE_MODES)
    expect(r).toEqual({ kind: "unavailable", requestedModeId: "architect" })
  })

  it("native resolution carries the harness's own mode label for the picker", () => {
    const withNames: SessionMode[] = [mode("plan", "Plan (proposes, does not act)")]
    const r = resolvePosture("plan", withNames)
    expect(r.kind).toBe("native")
    if (r.kind !== "native") return
    expect(r.mode.name).toBe("Plan (proposes, does not act)")
  })
})
