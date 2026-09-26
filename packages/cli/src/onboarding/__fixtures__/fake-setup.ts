/**
 * Fake `SetupIO` / `WizardDeps` for wizard tests: verbs record their calls
 * and return canned exit codes; prompts record what was asked and answer
 * from a script; nothing touches the machine.
 */

import type { SetupIO, SetupVerbs, StepContext, OnboardingStep } from "../types.js"
import type { WizardDeps } from "../wizard.js"

export interface FakeSetup {
  io: SetupIO
  deps: WizardDeps
  calls: string[]
  prompts: string[]
  logs: string[]
  ledgerWrites: { path: string; text: string }[]
  json: string[]
}

export interface FakeSetupOptions {
  interactive?: boolean
  /** Exit code per verb call (`"install claude-code"` → 1); default 0. */
  codes?: Record<string, number>
  /** Scripted prompt answers, consumed in order; default: accept defaults. */
  answers?: (string[] | boolean | string | null)[]
  ledger?: string | null
  steps?: readonly OnboardingStep[]
  doctorSteps?: readonly OnboardingStep[]
}

export function createFakeSetup(ctx: StepContext, opts: FakeSetupOptions = {}): FakeSetup {
  const calls: string[] = []
  const prompts: string[] = []
  const logs: string[] = []
  const ledgerWrites: { path: string; text: string }[] = []
  const json: string[] = []
  const answers = [...(opts.answers ?? [])]
  const code = (key: string) => {
    calls.push(key)
    return opts.codes?.[key] ?? 0
  }
  const verbs: SetupVerbs = {
    workspace: async (a) => code(`workspace ${a.join(" ")}`),
    daemon: async (a) => code(`daemon ${a.join(" ")}`),
    ensureDaemon: async () => (code("ensureDaemon") === 0 ? 18790 : null),
    install: async (a) => code(`install ${a.join(" ")}`),
    auth: async (a) => code(`auth ${a.join(" ")}`),
    installMcp: async (a) => code(`install-mcp ${a.join(" ")}`),
    installSkill: async (slug, a) => code(`install ${slug} ${a.join(" ")}`.trim()),
    updateCli: async () => code("npm i -g @agentproto/cli@latest"),
    modelsSummary: async () => [{ slug: "claude-code", runnable: 3, total: 4 }],
    firstRun: async (slug, _prompt, onLine) => {
      const c = code(`firstRun ${slug}`)
      onLine("hello from the agent")
      return c === 0 ? { ok: true } : { ok: false, error: "spawn failed" }
    },
    appInstalled: () => false,
  }
  type Answer = string[] | boolean | string | null
  /** Next scripted answer if it has the right shape, else the default. */
  const take = <T extends Answer>(fallback: T, fits: (v: Answer) => boolean, narrow: (v: Answer) => T | null): T | null => {
    if (answers.length === 0) return fallback
    const a = answers.shift() ?? null
    return fits(a) ? narrow(a) : fallback
  }
  const asBool = (v: Answer) => (typeof v === "boolean" ? v : null)
  const asStr = (v: Answer) => (typeof v === "string" ? v : null)
  const asList = (v: Answer) => (Array.isArray(v) ? v : null)
  const io: SetupIO = {
    interactive: opts.interactive ?? false,
    prompts: {
      confirm: async (m, initial) => {
        prompts.push(`confirm ${m}`)
        return take(initial, (v) => typeof v === "boolean" || v === null, asBool)
      },
      multiselect: async (m, _choices, initial) => {
        prompts.push(`multiselect ${m}`)
        return take([...initial], (v) => Array.isArray(v) || v === null, asList)
      },
      select: async (m, choices) => {
        prompts.push(`select ${m}`)
        return take(choices[0]?.value ?? "", (v) => typeof v === "string" || v === null, asStr)
      },
      text: async (m, initial) => {
        prompts.push(`text ${m}`)
        return take(initial, (v) => typeof v === "string" || v === null, asStr)
      },
      password: async (m) => {
        prompts.push(`password ${m}`)
        return take("sk-test", (v) => typeof v === "string" || v === null, asStr)
      },
    },
    log: {
      info: (m) => logs.push(`info ${m}`),
      success: (m) => logs.push(`success ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
      error: (m) => logs.push(`error ${m}`),
      step: (m) => logs.push(`step ${m}`),
      message: (m) => logs.push(`message ${m}`),
    },
    verbs,
  }
  const deps: WizardDeps = {
    ctx,
    io,
    ui: {
      intro: (t) => logs.push(`intro ${t}`),
      outro: (m) => logs.push(`outro ${m}`),
      note: (m, t) => logs.push(`note ${t}: ${m}`),
      spinner: () => ({
        start: (m) => logs.push(`spin ${m}`),
        stop: (m) => logs.push(`spin-ok ${m}`),
        error: (m) => logs.push(`spin-fail ${m}`),
      }),
    },
    steps: opts.steps ?? [],
    doctorSteps: opts.doctorSteps ?? [],
    ledger: {
      read: async () => opts.ledger ?? null,
      write: async (path, text) => {
        ledgerWrites.push({ path, text })
      },
    },
    runQuietly: async (fn) => ({ value: await fn(), output: "verb output line" }),
    runStreaming: (fn) => fn(),
    writeJson: (t) => json.push(t),
  }
  return { io, deps, calls, prompts, logs, ledgerWrites, json }
}
