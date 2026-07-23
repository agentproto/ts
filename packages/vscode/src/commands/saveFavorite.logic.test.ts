import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import { presetFromSession, slugifyPresetId } from "./saveFavorite.logic.js"

function session(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "proj",
    command: "claude",
    pid: 123,
    status: "running",
    startedAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  } as SessionDescriptor
}

describe("slugifyPresetId", () => {
  it("lowercases, collapses non-alphanumerics to a single dash, trims edges", () => {
    expect(slugifyPresetId("Fast Opus · this repo")).toBe("fast-opus-this-repo")
    expect(slugifyPresetId("  Hello!!World  ")).toBe("hello-world")
    expect(slugifyPresetId("already-good")).toBe("already-good")
  })

  it("produces an id the daemon's ^[a-z0-9][a-z0-9-]*$ rule accepts", () => {
    const slug = slugifyPresetId("2 Cool 4 School")
    expect(slug).toBe("2-cool-4-school")
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/)
  })

  it("returns undefined when nothing usable survives", () => {
    expect(slugifyPresetId("!!!")).toBeUndefined()
    expect(slugifyPresetId("   ")).toBeUndefined()
  })
})

describe("presetFromSession", () => {
  it("lifts every spawn axis the descriptor carries into a favorite", () => {
    const preset = presetFromSession(
      session({
        adapterSlug: "claude-code",
        model: "opus",
        route: { gateway: "openrouter" },
        accessProfile: { profileRef: "wallet-a", vendor: "anthropic", method: "oauth-bearer" },
        effort: "high",
        contextProfile: "lean",
        cwd: "/repo",
      }),
      { id: "fav", label: "Fav" },
    )
    expect(preset).toEqual({
      id: "fav",
      label: "Fav",
      adapter: "claude-code",
      model: "opus",
      route: { gateway: "openrouter" },
      access: { profileRef: "wallet-a" },
      effort: "high",
      contextProfile: "lean",
      cwd: "/repo",
    })
  })

  it("never captures credential material — only the non-secret profileRef", () => {
    const preset = presetFromSession(
      session({ accessProfile: { profileRef: "wallet-a", vendor: "anthropic", method: "oauth-bearer" } }),
      { id: "fav", label: "Fav" },
    )
    expect(preset.access).toEqual({ profileRef: "wallet-a" })
    // The descriptor's auth fingerprint block is never lifted into the preset.
    expect(JSON.stringify(preset)).not.toContain("fingerprint")
  })

  it("folds the AIP-45 mode into posture.harnessModeId when no posture is echoed", () => {
    const preset = presetFromSession(session({ mode: "plan" }), { id: "fav", label: "Fav" })
    expect(preset.posture).toEqual({ harnessModeId: "plan" })
  })

  it("prefers an explicit posture echo over the mode fold", () => {
    const preset = presetFromSession(
      session({ mode: "plan", posture: "bypass" }),
      { id: "fav", label: "Fav" },
    )
    expect(preset.posture).toBe("bypass")
  })

  it("omits axes the descriptor doesn't carry (no empty-string pins)", () => {
    const preset = presetFromSession(session(), { id: "bare", label: "Bare" })
    expect(preset).toEqual({ id: "bare", label: "Bare" })
    expect(preset).not.toHaveProperty("adapter")
    expect(preset).not.toHaveProperty("cwd")
  })
})
