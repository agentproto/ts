/**
 * The `agentproto setup` wizard runner: for each step, detect (read-only) →
 * plan → ask (or take defaults under --yes) → apply through existing verbs →
 * re-detect to verify. Ends with a full doctor run.
 *
 * Everything that changes the machine goes through the injected `SetupIO`;
 * everything that inspects it through `StepContext`. The runner itself only
 * writes the resume ledger (via `WizardDeps.ledger`).
 */

import { DEFAULT_PORT } from "../commands/install-mcp.js"
import { onboardingLedgerPath, parseOnboardingLedger, type OnboardingLedger, type OnboardingLedgerAction } from "./ledger.js"
import { hasRequiredFailure, runChecks, selectSteps, summarize, type ReportSummary } from "./run.js"
import { CONTROL_CENTER_APP } from "./steps/first-run.js"
import type { ApplyResult, OnboardingStep, SetupAction, SetupIO, StepCheck, StepContext, StepReport, StepStatus } from "./types.js"

export interface WizardOptions {
  /** Apply defaults without prompting; never applies secret actions. */
  yes: boolean
  /** Show the plan, apply nothing. */
  dryRun: boolean
  /** Print the final report as JSON on stdout (UI goes to stderr). */
  json: boolean
  only?: readonly string[]
  skip?: readonly string[]
}

export interface WizardSpinner {
  start(message: string): void
  stop(message: string): void
  error(message: string): void
}

export interface WizardUi {
  intro(title: string): void
  outro(message: string): void
  note(message: string, title: string): void
  spinner(): WizardSpinner
}

export interface WizardDeps {
  ctx: StepContext
  io: SetupIO
  ui: WizardUi
  steps: readonly OnboardingStep[]
  /** The steps of the closing doctor run. */
  doctorSteps: readonly OnboardingStep[]
  ledger: { read(path: string): Promise<string | null>; write(path: string, text: string): Promise<void> }
  /** Run `fn` with its stdout/stderr buffered (shown only on failure). */
  runQuietly<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }>
  /** Run `fn` with its output live (redirected to stderr in --json mode). */
  runStreaming<T>(fn: () => Promise<T>): Promise<T>
  /** Final machine-readable report (stdout). */
  writeJson(text: string): void
}

export interface AppliedAction {
  step: string
  action: string
  title: string
  status: "applied" | "failed" | "skipped" | "planned"
  detail?: string
  selected?: string[]
}

export interface WizardReport {
  version: string
  platform: string
  steps: StepReport[]
  summary: ReportSummary
  applied: AppliedAction[]
  stopped?: string
}

const GLYPH: Record<StepStatus, string> = { ok: "✓", warn: "!", missing: "✗", broken: "✗", skipped: "-" }

function checkLine(c: StepCheck): string {
  return `${GLYPH[c.status]} ${c.title}${c.detail ? `  ${c.detail}` : ""}${c.fix ? `\n    → fix: ${c.fix}` : ""}`
}

const settled = (c: StepCheck): boolean => c.status === "ok" || c.status === "skipped"

class Cancelled extends Error {}

/** Which choices / whether to apply, per the mode. `null` ⇒ don't apply. */
async function decide(action: SetupAction, io: SetupIO): Promise<{ selected?: string[] } | null> {
  const defaults = (action.choices ?? []).filter((c) => c.default).map((c) => c.value)
  if (!io.interactive) {
    if (!action.default) return null
    if (action.choices) return defaults.length > 0 ? { selected: defaults } : null
    return {}
  }
  if (action.choices) {
    const picked = await io.prompts.multiselect(action.title, action.choices, defaults)
    if (picked === null) throw new Cancelled()
    return picked.length > 0 ? { selected: picked } : null
  }
  const yes = await io.prompts.confirm(action.title, action.default)
  if (yes === null) throw new Cancelled()
  return yes ? {} : null
}

export async function runSetupWizard(opts: WizardOptions, deps: WizardDeps): Promise<{ code: number; report: WizardReport }> {
  const { ctx, io, ui } = deps
  const nowIso = () => new Date(ctx.now()).toISOString()
  const ledgerPath = onboardingLedgerPath(ctx.homedir)
  const ledger: OnboardingLedger = parseOnboardingLedger(await deps.ledger.read(ledgerPath), nowIso())
  const previous = new Map<string, StepCheck[]>()
  const applied: AppliedAction[] = []
  const notes: string[] = []
  let stopped: string | undefined
  let cancelled = false

  ui.intro(opts.dryRun ? "agentproto setup (dry run: nothing will change)" : "agentproto setup")

  for (const step of selectSteps(deps.steps, opts)) {
    const [before] = await runChecks([step], ctx)
    let checks = before?.checks ?? []
    previous.set(step.id, checks)

    const stop = step.stopIf?.(checks)
    if (stop) {
      io.log.error(`${step.title}: ${stop}`)
      stopped = stop
      break
    }

    if (checks.every(settled)) {
      const info = checks.every((c) => c.status === "skipped") ? checks[0]?.detail : undefined
      io.log.success(`${step.title}${info ? `  ${info}` : ""}`)
      if (!opts.dryRun) ledger.steps[step.id] = { status: "ok", at: nowIso(), actions: ledger.steps[step.id]?.actions ?? [] }
      continue
    }

    io.log.step(`${step.title}\n${checks.filter((c) => !settled(c)).map(checkLine).join("\n")}`)
    const actions = step.plan ? await step.plan(checks, ctx, previous) : []
    if (actions.length === 0) {
      io.log.info("Nothing to change automatically here — see the fixes above.")
      continue
    }

    const records: OnboardingLedgerAction[] = []
    let changed = false
    try {
      for (const action of actions) {
        const base = { step: step.id, action: action.id, title: action.title }
        if (opts.dryRun) {
          const choices = action.choices?.map((c) => `${c.default ? "[x]" : "[ ]"} ${c.label}`).join(", ")
          io.log.message(`would offer: ${action.title}${action.default ? " (default: yes)" : " (default: no)"}${choices ? `\n  ${choices}` : ""}`)
          applied.push({ ...base, status: "planned" })
          continue
        }
        if (action.needsSecret && !io.interactive) {
          applied.push({ ...base, status: "skipped", detail: "needs a secret — run `agentproto setup` interactively" })
          records.push({ id: action.id, status: "skipped" })
          continue
        }
        const decision = await decide(action, io)
        if (decision === null) {
          applied.push({ ...base, status: "skipped", detail: "declined" })
          records.push({ id: action.id, status: "skipped" })
          continue
        }
        const run = () =>
          action.apply(io, decision.selected).catch((err: unknown): ApplyResult => ({
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          }))
        let result: ApplyResult
        if (action.streamsOutput) {
          io.log.step(action.title)
          result = await deps.runStreaming(run)
          if (result.ok) io.log.success(result.detail ?? "done")
          else io.log.error(result.detail ?? "failed")
        } else {
          const spin = ui.spinner()
          spin.start(action.title)
          const { value, output } = await deps.runQuietly(run)
          result = value
          if (result.ok) spin.stop(`${action.title} — ${result.detail ?? "done"}`)
          else {
            spin.error(`${action.title} — ${result.detail ?? "failed"}`)
            const tail = output.trim().split("\n").slice(-8).join("\n")
            if (tail) io.log.message(tail)
          }
        }
        changed = true
        notes.push(...(result.notes ?? []))
        applied.push({
          ...base,
          status: result.ok ? "applied" : "failed",
          ...(result.detail ? { detail: result.detail } : {}),
          ...(decision.selected ? { selected: decision.selected } : {}),
        })
        records.push({ id: action.id, status: result.ok ? "applied" : "failed", ...(result.detail ? { detail: result.detail } : {}) })
      }
    } catch (err) {
      if (!(err instanceof Cancelled)) throw err
      cancelled = true
    }

    if (changed) {
      // Verify: re-detect and show where the step landed.
      const [after] = await runChecks([step], ctx)
      checks = after?.checks ?? checks
      previous.set(step.id, checks)
      io.log.message(checks.map(checkLine).join("\n"))
      const extra = step.report ? await step.report(io) : []
      if (extra.length > 0) io.log.info(extra.join("\n"))
    }
    if (!opts.dryRun) {
      ledger.steps[step.id] = { status: checks.every(settled) ? "ok" : "incomplete", at: nowIso(), actions: records }
    }
    if (cancelled) break
  }

  if (!opts.dryRun) await deps.ledger.write(ledgerPath, JSON.stringify(ledger, null, 2) + "\n")

  const final = await runChecks(deps.doctorSteps, ctx)
  const summary = summarize(final)
  const report: WizardReport = {
    version: ctx.cliVersion,
    platform: `${ctx.platform}/${ctx.arch}`,
    steps: final,
    summary,
    applied,
    ...(stopped ? { stopped } : {}),
  }

  if (notes.length > 0) ui.note(notes.join("\n\n"), "Finish by hand")
  const port = (await ctx.sources.loadConfig()).daemon?.port ?? DEFAULT_PORT
  const app = io.verbs.appInstalled(CONTROL_CENTER_APP) ? CONTROL_CENTER_APP : "@agentproto/sessions-panel"
  ui.note(
    [
      `Control Center  http://127.0.0.1:${port}/apps/${app}/ui`,
      "Your phone      agentproto remote enable --qr",
      "Pair a device   agentproto pair offer",
      "Sandboxes       agentproto sandbox list",
      "Re-check        agentproto doctor",
    ].join("\n"),
    "Next",
  )
  const failedActions = applied.filter((a) => a.status === "failed").length
  const outcome = cancelled
    ? "Setup cancelled — re-run `agentproto setup` to resume."
    : stopped
      ? "Setup stopped — fix the blocker above and re-run `agentproto setup`."
      : `${summary.ok} ok · ${summary.warn} warn · ${summary.missing} missing · ${summary.broken} broken` +
        (failedActions > 0 ? ` · ${failedActions} action(s) failed` : "")
  ui.outro(outcome)
  if (opts.json) deps.writeJson(JSON.stringify(report, null, 2) + "\n")

  const code = cancelled || stopped || hasRequiredFailure(final) ? 1 : 0
  return { code, report }
}
