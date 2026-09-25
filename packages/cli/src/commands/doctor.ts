/**
 * `agentproto doctor` — read-only health check of an agentproto install.
 *
 * Runs every onboarding step's `detect` (see `../onboarding/`) and prints
 * one line per check, grouped by step. Changes nothing: no file writes, no
 * process starts, no prompts.
 *
 * Exit code: 0 unless a REQUIRED step (preflight, workspace, daemon,
 * agents) has a `missing` or `broken` check; `warn` never fails.
 */

import { parseArgs } from "node:util"
import { ONBOARDING_STEPS } from "../onboarding/registry.js"
import { hasRequiredFailure, runChecks, summarize, type ReportSummary } from "../onboarding/run.js"
import { createStepContext } from "../onboarding/context.js"
import type { OnboardingStep, StepContext, StepReport, StepStatus } from "../onboarding/types.js"

const USAGE = `agentproto doctor — check this agentproto install (read-only)

Usage:
  agentproto doctor [--json] [--only <step>]... [--skip <step>]...

Options:
  --json          machine-readable report (attach it to bug reports)
  --only <step>   run only this step (repeatable)
  --skip <step>   skip this step (repeatable)
  -h, --help      show this help

Steps: preflight, workspace, daemon, agents, auth, clients, skills

Exit code is 1 when a required step (preflight, workspace, daemon, agents)
reports a missing or broken check, 0 otherwise.
`

export interface DoctorOutput {
  write(chunk: string): unknown
  isTTY?: boolean
}

export interface DoctorDeps {
  context: () => StepContext
  steps: readonly OnboardingStep[]
  stdout: DoctorOutput
  stderr: DoctorOutput
  env: Readonly<Record<string, string | undefined>>
}

export interface DoctorJson {
  version: string
  platform: string
  steps: StepReport[]
  summary: ReportSummary
}

function cliVersion(): string {
  return typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0-dev"
}

const REAL_DEPS: DoctorDeps = {
  context: () => createStepContext(cliVersion()),
  steps: ONBOARDING_STEPS,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
}

const GLYPH: Record<StepStatus, string> = { ok: "✓", warn: "!", missing: "✗", broken: "✗", skipped: "-" }
const COLOR: Record<StepStatus, string> = {
  ok: "\x1b[32m",
  warn: "\x1b[33m",
  missing: "\x1b[31m",
  broken: "\x1b[31m",
  skipped: "\x1b[2m",
}
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"

export function renderHuman(
  reports: readonly StepReport[],
  meta: { version: string; platform: string },
  color: boolean,
): string {
  const paint = (code: string, s: string) => (color ? `${code}${s}${RESET}` : s)
  let out = `agentproto doctor — v${meta.version} · ${meta.platform}\n`
  for (const r of reports) {
    out += `\n${paint(BOLD, r.title)}${r.required ? "" : paint(DIM, " (optional)")}\n`
    for (const c of r.checks) {
      out += `  ${paint(COLOR[c.status], GLYPH[c.status])} ${c.title}${c.detail ? `  ${paint(DIM, c.detail)}` : ""}\n`
      if (c.fix) out += `      → fix: ${c.fix}\n`
    }
  }
  const s = summarize(reports)
  out +=
    `\n${s.ok} ok · ${s.warn} warn · ${s.missing} missing · ${s.broken} broken\n` +
    "Run `agentproto doctor --json` and attach it to bug reports.\n"
  return out
}

export async function runDoctor(args: readonly string[], deps: DoctorDeps = REAL_DEPS): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout.write(USAGE)
    return 0
  }
  let values
  try {
    ;({ values } = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      options: {
        json: { type: "boolean" },
        only: { type: "string", multiple: true },
        skip: { type: "string", multiple: true },
      },
    }))
  } catch (err) {
    deps.stderr.write(`agentproto doctor: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 2
  }
  const known = new Set(deps.steps.map((s) => s.id))
  const unknown = [...(values.only ?? []), ...(values.skip ?? [])].filter((id) => !known.has(id))
  if (unknown.length > 0) {
    deps.stderr.write(
      `agentproto doctor: unknown step(s): ${unknown.join(", ")}. Known: ${[...known].join(", ")}\n`,
    )
    return 2
  }

  const ctx = deps.context()
  const reports = await runChecks(deps.steps, ctx, {
    ...(values.only ? { only: values.only } : {}),
    ...(values.skip ? { skip: values.skip } : {}),
  })
  const meta = { version: ctx.cliVersion, platform: `${ctx.platform}/${ctx.arch}` }

  if (values.json) {
    const json: DoctorJson = { ...meta, steps: reports, summary: summarize(reports) }
    deps.stdout.write(JSON.stringify(json, null, 2) + "\n")
  } else {
    const color = deps.stdout.isTTY === true && deps.env.NO_COLOR === undefined
    deps.stdout.write(renderHuman(reports, meta, color))
  }
  return hasRequiredFailure(reports) ? 1 : 0
}
