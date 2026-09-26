/**
 * `agentproto setup` (no slug) command layer: TTY rule, flag validation,
 * onboard-compat verb narrowing. The slug path is covered by the existing
 * setup tests and must stay unchanged.
 */

import { describe, it, expect } from "vitest"
import { EXIT_SETUP_NEEDS_TTY, runSetupWizardCommand, type SetupWizardCommandDeps } from "../commands/setup.js"
import type { OnboardingStep } from "../onboarding/types.js"
import { createFakeContext } from "../onboarding/__fixtures__/fake-context.js"
import { createFakeSetup, type FakeSetup } from "../onboarding/__fixtures__/fake-setup.js"

/** One step whose single action calls the verbs the onboard flags narrow. */
const step: OnboardingStep = {
  id: "skills",
  title: "Skills",
  required: false,
  detect: async () => [{ id: "skills.x", title: "x", status: "warn" }],
  plan: async () => [
    {
      id: "skills.install",
      title: "install",
      default: true,
      apply: async (io) => {
        await io.verbs.installSkill("skill/agentproto-pack", ["--force"])
        await io.verbs.installMcp(["--agent", "cursor", "--agent", "windsurf", "--yes"])
        return { ok: true }
      },
    },
  ],
}

function harness(isTTY: boolean): { deps: SetupWizardCommandDeps; fake: () => FakeSetup | undefined; err: () => string; built: () => { interactive: boolean; json: boolean }[] } {
  let fake: FakeSetup | undefined
  let err = ""
  const built: { interactive: boolean; json: boolean }[] = []
  return {
    deps: {
      isTTY,
      stderr: { write: (s: string) => (err += s) },
      build: async (opts) => {
        built.push(opts)
        fake = createFakeSetup(createFakeContext(), { steps: [step], doctorSteps: [], interactive: opts.interactive })
        return fake.deps
      },
    },
    fake: () => fake,
    err: () => err,
    built: () => built,
  }
}

describe("agentproto setup (wizard)", () => {
  it("no TTY and no --yes ⇒ exit 78 with a hint, nothing runs", async () => {
    const h = harness(false)
    expect(await runSetupWizardCommand([], h.deps)).toBe(EXIT_SETUP_NEEDS_TTY)
    expect(h.err()).toContain("--yes")
    expect(h.built()).toEqual([])
  })

  it("--yes and --dry-run run without a TTY, never interactively", async () => {
    const yes = harness(false)
    expect(await runSetupWizardCommand(["--yes"], yes.deps)).toBe(0)
    expect(yes.built()).toEqual([{ interactive: false, json: false }])

    const dry = harness(true)
    await runSetupWizardCommand(["--dry-run"], dry.deps)
    expect(dry.built()).toEqual([{ interactive: false, json: false }])
    expect(dry.fake()?.calls).toEqual([])
  })

  it("a TTY without --yes is interactive", async () => {
    const h = harness(true)
    await runSetupWizardCommand([], h.deps)
    expect(h.built()).toEqual([{ interactive: true, json: false }])
  })

  it("unknown step ids and flags exit 2", async () => {
    const h = harness(true)
    expect(await runSetupWizardCommand(["--only", "nope"], h.deps)).toBe(2)
    expect(await runSetupWizardCommand(["--bogus"], h.deps)).toBe(2)
  })

  it("onboard compat: --skills swaps the skill, --agent narrows MCP registration", async () => {
    const h = harness(false)
    await runSetupWizardCommand(["--yes", "--skills", "ap-spawn-agent", "--agent", "windsurf"], h.deps)
    expect(h.fake()?.calls).toEqual(["install skill/ap-spawn-agent --force", "install-mcp --agent windsurf --yes"])
  })
})
