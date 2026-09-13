import { describe, expect, it } from "vitest"
import {
  BUILD_MODE,
  DEFAULT_MODE_ID,
  DEFAULT_MODES,
  PLAN_MODE,
  REVIEW_MODE,
  parseModesFromAgentMd,
  resolveModes,
} from "../modes.js"

describe("built-in modes", () => {
  it("plan is the default and transitions to build", () => {
    expect(PLAN_MODE.id).toBe("plan")
    expect(PLAN_MODE.metadata).toEqual({ default: true })
    expect(PLAN_MODE.transitionsTo).toBe("build")
    expect(PLAN_MODE.availableTools).toEqual([
      "read_file",
      "list_dir",
      "read_diff",
      "run_command",
      "submit_plan",
    ])
  })

  it("build has no tool restriction and transitions to review", () => {
    expect(BUILD_MODE.availableTools).toBeUndefined()
    expect(BUILD_MODE.transitionsTo).toBe("review")
  })

  it("review is read/check-only and transitions back to plan", () => {
    expect(REVIEW_MODE.transitionsTo).toBe("plan")
    expect(REVIEW_MODE.availableTools).toEqual([
      "read_file",
      "read_diff",
      "run_command",
      "run_tests",
      "list_dir",
    ])
  })

  it("DEFAULT_MODES / DEFAULT_MODE_ID match plan/build/review", () => {
    expect(DEFAULT_MODES.map((m) => m.id)).toEqual(["plan", "build", "review"])
    expect(DEFAULT_MODE_ID).toBe("plan")
  })
})

describe("parseModesFromAgentMd", () => {
  it("returns undefined when the body has no '## Modes' section", () => {
    expect(parseModesFromAgentMd("Just an ordinary agent body.\n\n## Tools\n- read_file\n")).toBeUndefined()
  })

  it("parses a custom '## Modes' section", () => {
    const body = [
      "Some intro prose.",
      "",
      "## Modes",
      "",
      "### explore",
      "default: true",
      "tools: read_file, list_dir",
      "transitions_to: act",
      "",
      "Look around before doing anything.",
      "",
      "### act",
      "transitions_to: explore",
      "",
      "Make the change.",
      "",
      "## Tools",
      "- read_file",
    ].join("\n")

    const parsed = parseModesFromAgentMd(body)
    expect(parsed).toBeDefined()
    expect(parsed!.defaultModeId).toBe("explore")
    expect(parsed!.modes).toEqual([
      {
        id: "explore",
        name: "Explore",
        instructions: "Look around before doing anything.",
        availableTools: ["read_file", "list_dir"],
        transitionsTo: "act",
        metadata: { default: true },
      },
      {
        id: "act",
        name: "Act",
        instructions: "Make the change.",
        transitionsTo: "explore",
      },
    ])
  })

  it("defaults to the first subsection when none is flagged default", () => {
    const body = ["## Modes", "", "### one", "First mode.", "", "### two", "Second mode."].join("\n")
    const parsed = parseModesFromAgentMd(body)
    expect(parsed!.defaultModeId).toBe("one")
    expect(parsed!.modes.find((m) => m.id === "one")!.metadata).toEqual({ default: true })
  })

  it("a mode with no instructions and no keys parses with an empty body", () => {
    const body = ["## Modes", "", "### bare", "### other", "Has text."].join("\n")
    const parsed = parseModesFromAgentMd(body)
    expect(parsed!.modes[0]).toEqual({
      id: "bare",
      name: "Bare",
      metadata: { default: true },
    })
  })

  it("throws when '## Modes' has no '### ' subsections", () => {
    expect(() => parseModesFromAgentMd("## Modes\n\nJust prose, no subsections.\n")).toThrow(
      /no '### <mode-id>' subsections/,
    )
  })

  it("throws on a '### ' heading with an empty id", () => {
    expect(() => parseModesFromAgentMd("## Modes\n\n### \nBody.\n")).toThrow(/no mode id/)
  })

  it("throws on a duplicate mode id", () => {
    const body = ["## Modes", "### plan", "One.", "### plan", "Two."].join("\n")
    expect(() => parseModesFromAgentMd(body)).toThrow(/duplicate mode id 'plan'/)
  })

  it("throws when more than one mode is flagged default", () => {
    const body = [
      "## Modes",
      "### a",
      "default: true",
      "A.",
      "### b",
      "default: true",
      "B.",
    ].join("\n")
    expect(() => parseModesFromAgentMd(body)).toThrow(/more than one mode flagged/)
  })
})

describe("resolveModes", () => {
  it("falls back to the built-in modes when there is no '## Modes' section", () => {
    const resolved = resolveModes("No modes section here.")
    expect(resolved.defaultModeId).toBe(DEFAULT_MODE_ID)
    expect(resolved.modes.map((m) => m.id)).toEqual(["plan", "build", "review"])
  })

  it("uses the AGENT.md's own modes when present", () => {
    const body = ["## Modes", "### solo", "default: true", "Only mode."].join("\n")
    const resolved = resolveModes(body)
    expect(resolved.defaultModeId).toBe("solo")
    expect(resolved.modes).toHaveLength(1)
  })
})
