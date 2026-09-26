/**
 * The setup wizard runner over synthetic steps and a fake SetupIO:
 * --yes / --dry-run / interactive decisions, resume, failure isolation,
 * verify, stop, ledger.
 */

import { describe, it, expect } from "vitest"
import { runSetupWizard, type WizardOptions } from "./wizard.js"
import type { OnboardingStep, SetupAction, StepStatus } from "./types.js"
import { createFakeContext } from "./__fixtures__/fake-context.js"
import { createFakeSetup, type FakeSetupOptions } from "./__fixtures__/fake-setup.js"

const YES: WizardOptions = { yes: true, dryRun: false, json: false }

/** A step whose status flips to ok once `fixed` is set by one of its actions. */
function step(id: string, actions: (fix: () => void) => SetupAction[], initial: StepStatus = "warn"): OnboardingStep {
  let status = initial
  return {
    id,
    title: id,
    required: true,
    detect: async () => [{ id: `${id}.x`, title: id, status }],
    plan: async () => actions(() => (status = "ok")),
  }
}

function act(id: string, over: Partial<SetupAction> = {}, fix?: () => void): SetupAction {
  return {
    id,
    title: id,
    default: true,
    apply: async (io) => {
      const code = await io.verbs.install([id])
      if (code === 0) fix?.()
      return code === 0 ? { ok: true, detail: "done" } : { ok: false, detail: `exit ${code}` }
    },
    ...over,
  }
}

function setup(steps: OnboardingStep[], opts: FakeSetupOptions = {}) {
  return createFakeSetup(createFakeContext(), { steps, doctorSteps: steps, ...opts })
}

describe("--yes", () => {
  it("applies defaults, skips non-defaults and secrets, never prompts", async () => {
    const s = setup([
      step("a", (fix) => [
        act("a.default", {}, fix),
        act("a.optional", { default: false }),
        act("a.secret", { needsSecret: true, default: true }),
        act("a.choices", {
          choices: [
            { value: "one", label: "one", default: true },
            { value: "two", label: "two" },
          ],
          apply: async (io, selected = []) => {
            await io.verbs.install(selected)
            return { ok: true }
          },
        }),
      ]),
    ])
    const { code, report } = await runSetupWizard(YES, s.deps)
    expect(s.prompts).toEqual([])
    expect(s.calls).toEqual(["install a.default", "install one"])
    expect(report.applied.map((a) => `${a.action}:${a.status}`)).toEqual([
      "a.default:applied",
      "a.optional:skipped",
      "a.secret:skipped",
      "a.choices:applied",
    ])
    expect(code).toBe(0)
  })

  it("a choices action with nothing pre-selected is not applied", async () => {
    const s = setup([step("a", () => [act("a.c", { default: false, choices: [{ value: "x", label: "x" }] })])])
    await runSetupWizard(YES, s.deps)
    expect(s.calls).toEqual([])
  })
})

describe("--dry-run", () => {
  it("shows the plan, applies nothing, writes no ledger", async () => {
    const s = setup([step("a", (fix) => [act("a.go", {}, fix)])])
    const { report } = await runSetupWizard({ yes: false, dryRun: true, json: false }, s.deps)
    expect(s.calls).toEqual([])
    expect(s.ledgerWrites).toEqual([])
    expect(report.applied).toEqual([{ step: "a", action: "a.go", title: "a.go", status: "planned" }])
    expect(s.logs.some((l) => l.startsWith("message would offer: a.go"))).toBe(true)
  })
})

describe("interactive", () => {
  it("asks confirm / multiselect with the defaults and applies the answers", async () => {
    const s = setup(
      [
        step("a", () => [
          act("a.ask", { default: false }),
          act("a.pick", {
            choices: [
              { value: "one", label: "one", default: true },
              { value: "two", label: "two" },
            ],
            apply: async (io, selected = []) => {
              await io.verbs.install(selected)
              return { ok: true }
            },
          }),
          act("a.secret", { needsSecret: true, default: false }),
        ]),
      ],
      { interactive: true, answers: [true, ["two"], false] },
    )
    await runSetupWizard({ yes: false, dryRun: false, json: false }, s.deps)
    expect(s.prompts).toEqual(["confirm a.ask", "multiselect a.pick", "confirm a.secret"])
    expect(s.calls).toEqual(["install a.ask", "install two"])
  })

  it("cancelling a prompt ends the wizard (exit 1) but still writes the ledger", async () => {
    const s = setup([step("a", () => [act("a.1")]), step("b", () => [act("b.1")])], { interactive: true, answers: [null] })
    const { code } = await runSetupWizard({ yes: false, dryRun: false, json: false }, s.deps)
    expect(code).toBe(1)
    expect(s.calls).toEqual([])
    expect(s.prompts).toEqual(["confirm a.1"])
    expect(s.ledgerWrites).toHaveLength(1)
  })
})

describe("resume, failures, verify", () => {
  it("steps already ok are a one-line ✓ and are not planned", async () => {
    let planned = false
    const ok: OnboardingStep = {
      id: "done",
      title: "Done step",
      required: true,
      detect: async () => [{ id: "done.x", title: "x", status: "ok" }],
      plan: async () => {
        planned = true
        return []
      },
    }
    const s = setup([ok])
    await runSetupWizard(YES, s.deps)
    expect(planned).toBe(false)
    expect(s.logs).toContain("success Done step")
  })

  it("a failing action doesn't abort later actions or steps, and is reported", async () => {
    const s = setup([step("a", () => [act("a.bad"), act("a.good")]), step("b", (fix) => [act("b.go", {}, fix)])], {
      codes: { "install a.bad": 1 },
    })
    const { code, report } = await runSetupWizard(YES, s.deps)
    expect(s.calls).toEqual(["install a.bad", "install a.good", "install b.go"])
    expect(report.applied.find((a) => a.action === "a.bad")).toMatchObject({ status: "failed", detail: "exit 1" })
    // Failed output is surfaced, and the outro counts it.
    expect(s.logs).toContain("message verb output line")
    expect(s.logs.some((l) => l.startsWith("outro") && l.includes("1 action(s) failed"))).toBe(true)
    // Step a is still `warn` after verify: reported, but warn never fails the run.
    expect(report.summary.warn).toBe(1)
    expect(code).toBe(0)
  })

  it("a throwing action is caught and recorded as failed", async () => {
    const s = setup([
      step("a", () => [
        act("a.throw", {
          apply: async () => {
            throw new Error("boom")
          },
        }),
        act("a.next"),
      ]),
    ])
    const { report } = await runSetupWizard(YES, s.deps)
    expect(report.applied.map((a) => `${a.action}:${a.status}:${a.detail ?? ""}`)).toEqual([
      "a.throw:failed:boom",
      "a.next:applied:done",
    ])
  })

  it("re-detects after applying and records the step ok in the ledger", async () => {
    const s = setup([step("a", (fix) => [act("a.go", {}, fix)])])
    await runSetupWizard(YES, s.deps)
    expect(s.logs).toContain("message ✓ a")
    const ledger = JSON.parse(s.ledgerWrites[0]?.text ?? "{}")
    expect(ledger.steps.a).toMatchObject({ status: "ok", actions: [{ id: "a.go", status: "applied" }] })
    expect(s.ledgerWrites[0]?.path).toContain(".agentproto/setup/_onboarding.json")
  })

  it("stopIf halts the wizard before later steps", async () => {
    const blocker: OnboardingStep = {
      id: "preflight",
      title: "Preflight",
      required: true,
      detect: async () => [{ id: "preflight.node", title: "Node", status: "broken" }],
      stopIf: () => "Node too old",
    }
    const s = setup([blocker, step("b", () => [act("b.go")])])
    const { code, report } = await runSetupWizard(YES, s.deps)
    expect(code).toBe(1)
    expect(report.stopped).toBe("Node too old")
    expect(s.calls).toEqual([])
  })
})

describe("--only / --skip / --json / Next", () => {
  it("filters steps and prints the doctor-shaped report as JSON", async () => {
    const s = setup([step("a", (fix) => [act("a.go", {}, fix)]), step("b", () => [act("b.go")])])
    await runSetupWizard({ ...YES, json: true, skip: ["b"] }, s.deps)
    expect(s.calls).toEqual(["install a.go"])
    const json = JSON.parse(s.json[0] ?? "{}")
    expect(Object.keys(json)).toEqual(["version", "platform", "steps", "summary", "applied"])
    expect(json.applied).toEqual([{ step: "a", action: "a.go", title: "a.go", status: "applied", detail: "done" }])
  })

  it("Next hints point at the Control Center and `remote enable --qr`", async () => {
    const s = setup([])
    await runSetupWizard(YES, s.deps)
    const next = s.logs.find((l) => l.startsWith("note Next:")) ?? ""
    expect(next).toContain("agentproto remote enable --qr")
    expect(next).toContain("http://127.0.0.1:18790/apps/@agentproto/sessions-panel/ui")
  })
})
