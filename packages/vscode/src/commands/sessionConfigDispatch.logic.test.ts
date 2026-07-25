import { describe, expect, it } from "vitest"

import type { ConfigAxis, ConfigChip, ConfigChipRow } from "./sessionConfig.logic.js"
import {
  liveFallbackToRestart,
  planChipDispatch,
  restartOverrideFor,
} from "./sessionConfigDispatch.logic.js"

function chip(over: Partial<ConfigChip>): ConfigChip {
  return { axis: "model", verb: "agent_set_model", restart: false, rows: [], ...over }
}
function row(over: Partial<ConfigChipRow>): ConfigChipRow {
  return { label: "r", value: "v", restartRequired: false, ...over }
}

describe("restartOverrideFor", () => {
  const cases: [ConfigAxis, string, unknown][] = [
    ["model", "claude-opus", { model: "claude-opus" }],
    ["effort", "high", { effort: "high" }],
    ["route", "moonshot", { route: { gateway: "moonshot" } }],
    ["access", "max-agentik", { access: { profileRef: "max-agentik" } }],
    ["contextProfile", "lean", { contextProfile: "lean" }],
  ]
  it.each(cases)("maps %s", (axis, value, expected) => {
    expect(restartOverrideFor(axis, value)).toEqual(expected)
  })

  it("passes a canonical posture as a bare string, a raw mode id as { harnessModeId }", () => {
    expect(restartOverrideFor("posture", "plan")).toEqual({ posture: "plan" })
    expect(restartOverrideFor("posture", "acme-turbo")).toEqual({ posture: { harnessModeId: "acme-turbo" } })
  })

  it("rewrites a parseable model's @route suffix for a route chip instead of setting route.gateway", () => {
    expect(restartOverrideFor("route", "openrouter", "anthropic/claude-sonnet-5")).toEqual({
      model: "anthropic/claude-sonnet-5@openrouter",
    })
  })

  it("falls back to route.gateway for a route chip when the current model is bare/unparseable", () => {
    expect(restartOverrideFor("route", "openrouter", "claude-opus-4-8")).toEqual({
      route: { gateway: "openrouter" },
    })
  })

  it("falls back to route.gateway when the picked route does not change the model's suffix", () => {
    expect(restartOverrideFor("route", "anthropic", "anthropic/claude-sonnet-5")).toEqual({
      route: { gateway: "anthropic" },
    })
  })
})

describe("planChipDispatch", () => {
  it("short-circuits the add-profile row", () => {
    expect(planChipDispatch(chip({ axis: "access", verb: "session_restart", restart: true }), row({ addProfile: true, value: "" })).kind).toBe("addProfile")
  })

  it("no-ops the current row", () => {
    expect(planChipDispatch(chip({}), row({ current: true })).kind).toBe("noop")
  })

  it("routes a restart-only chip through session_restart", () => {
    const d = planChipDispatch(chip({ axis: "route", verb: "session_restart", restart: true }), row({ value: "openrouter" }))
    expect(d).toEqual({ kind: "restart", axis: "route", value: "openrouter", override: { route: { gateway: "openrouter" } } })
  })

  it("runs a live chip's ordinary row via the live verb", () => {
    const d = planChipDispatch(chip({ axis: "model", verb: "agent_set_model", restart: false }), row({ value: "claude-sonnet" }))
    expect(d).toEqual({ kind: "live", verb: "agent_set_model", axis: "model", value: "claude-sonnet", override: { model: "claude-sonnet" } })
  })

  it("routes a live chip's restart-tagged row (model↔route trap) through session_restart", () => {
    const d = planChipDispatch(chip({ axis: "model", verb: "agent_set_model", restart: false }), row({ value: "deepseek@openrouter", restartRequired: true }))
    expect(d.kind).toBe("restart")
  })

  it("routes a route chip through session_restart and rewrites the model @route suffix when parseable", () => {
    const d = planChipDispatch(
      chip({ axis: "route", verb: "session_restart", restart: true }),
      row({ value: "openrouter" }),
      "anthropic/claude-sonnet-5",
    )
    expect(d).toEqual({
      kind: "restart",
      axis: "route",
      value: "openrouter",
      override: { model: "anthropic/claude-sonnet-5@openrouter" },
    })
  })
})

describe("liveFallbackToRestart", () => {
  it("is true only for applied:false + requires-restart", () => {
    expect(liveFallbackToRestart({ applied: false, reason: "requires-restart" })).toBe(true)
    expect(liveFallbackToRestart({ applied: false, reason: "not-supported" })).toBe(false)
    expect(liveFallbackToRestart({ applied: true })).toBe(false)
    expect(liveFallbackToRestart({})).toBe(false)
  })
})
