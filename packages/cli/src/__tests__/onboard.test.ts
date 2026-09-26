/**
 * `agentproto onboard` is an alias of the `setup` wizard: its flags map onto
 * wizard args, and it hands them to the wizard command.
 */

import { describe, it, expect } from "vitest"
import { mapOnboardArgs, runOnboard } from "../commands/onboard.js"

describe("mapOnboardArgs", () => {
  it("no flags ⇒ the interactive wizard", () => {
    expect(mapOnboardArgs([])).toEqual([])
  })

  it("--yes passes through", () => {
    expect(mapOnboardArgs(["--yes"])).toEqual(["--yes"])
  })

  it("--no-skills skips the skills step", () => {
    expect(mapOnboardArgs(["--no-skills"])).toEqual(["--skip", "skills"])
  })

  it("--skills and repeated --agent are forwarded", () => {
    expect(mapOnboardArgs(["--skills", "nested-orchestration", "--agent", "claude", "--agent", "cursor"])).toEqual([
      "--skills",
      "nested-orchestration",
      "--agent",
      "claude",
      "--agent",
      "cursor",
    ])
  })

  it("rejects unknown flags", () => {
    expect(() => mapOnboardArgs(["--bogus"])).toThrow()
  })
})

describe("runOnboard", () => {
  it("runs the wizard with the mapped args and returns its exit code", async () => {
    const calls: (readonly string[])[] = []
    const code = await runOnboard(["--yes", "--no-skills"], async (a) => {
      calls.push(a)
      return 3
    })
    expect(calls).toEqual([["--yes", "--skip", "skills"]])
    expect(code).toBe(3)
  })

  it("an unknown flag exits 2 without running the wizard", async () => {
    let ran = false
    const code = await runOnboard(["--nope"], async () => {
      ran = true
      return 0
    })
    expect(code).toBe(2)
    expect(ran).toBe(false)
  })
})
