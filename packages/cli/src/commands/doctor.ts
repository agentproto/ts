/**
 * `agentproto doctor`: health check of an agentproto install.
 *
 * Runs every onboarding step's `detect` (see `../onboarding/`) and prints
 * one line per check, grouped by step. Read-only unless `--fix` is passed:
 * then, and only then, it makes the one consented edit to Claude Code's user
 * settings (`crossSessionInbound: "accept"`, see {@link applyCrossSessionInboundFix}).
 *
 * Exit code: 0 unless a REQUIRED step (preflight, workspace, daemon,
 * agents) has a `missing` or `broken` check; `warn` never fails.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { ONBOARDING_STEPS } from "../onboarding/registry.js"
import { hasRequiredFailure, runChecks, summarize, type ReportSummary } from "../onboarding/run.js"
import { checkHookPath, HOOK_STEP_ID, realHookBinLookup, type HookBinLookup } from "./doctor-hook-path.js"
import { createStepContext } from "../onboarding/context.js"
import type { OnboardingStep, StepContext, StepReport, StepStatus } from "../onboarding/types.js"

const USAGE = `agentproto doctor: check this agentproto install

Usage:
  agentproto doctor [--json] [--fix] [--only <step>]... [--skip <step>]...

Options:
  --fix           set "crossSessionInbound": "accept" in ~/.claude/settings.json so a
                  Claude Code session in bypassPermissions accepts messages from other
                  sessions (backs the file up first, keeps every other key, prints the diff)
                  also prints, without writing it, the diff that would put an absolute
                  path in the \`agentproto hook\` commands when they do not resolve in
                  your login shell PATH
  --json          machine-readable report (attach it to bug reports)
  --only <step>   run only this step (repeatable)
  --skip <step>   skip this step (repeatable)
  -h, --help      show this help

Steps: preflight, workspace, daemon, agents, auth, clients, devices, skills, local-models, hooks

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
  /** Claude Code user settings file `--fix` edits. Default
   *  `$CLAUDE_CONFIG_DIR/settings.json` or `~/.claude/settings.json`. */
  claudeSettingsFile?: string
  /** Resolves a command in the login shell / this process. When absent the
   *  hook PATH check is skipped (tests); the real deps shell out. */
  hookBinLookup?: HookBinLookup
}

export interface CrossSessionInboundFix {
  file: string
  status: "added" | "already-set" | "failed"
  /** Value found when `status` is `already-set`. */
  current?: string
  backup?: string
  diff?: string
  error?: string
}

function lineDiff(before: string, after: string): string {
  const a = before.split("\n")
  const b = after.split("\n")
  const inA = new Set(a)
  const inB = new Set(b)
  return [
    ...a.filter((l) => !inB.has(l)).map((l) => `- ${l}`),
    ...b.filter((l) => !inA.has(l)).map((l) => `+ ${l}`),
  ].join("\n")
}

/**
 * Add `"crossSessionInbound": "accept"` to Claude Code's user settings.
 * Backs the file up first, writes atomically (temp file + rename), keeps every
 * other key, and does nothing when the key is already set to any value (an
 * explicit `hold` / `refuse` is the user's choice). Refuses a file that is not
 * a JSON object rather than rewriting it.
 */
export function applyCrossSessionInboundFix(file: string, now: () => Date = () => new Date()): CrossSessionInboundFix {
  let before = ""
  let settings: Record<string, unknown> = {}
  if (existsSync(file)) {
    try {
      before = readFileSync(file, "utf8")
      const parsed: unknown = JSON.parse(before)
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object")
      settings = parsed as Record<string, unknown>
    } catch (err) {
      return {
        file,
        status: "failed",
        error: `cannot parse ${file} (${err instanceof Error ? err.message : String(err)}); left untouched`,
      }
    }
  }
  if (typeof settings.crossSessionInbound === "string") {
    return { file, status: "already-set", current: settings.crossSessionInbound }
  }
  const after = JSON.stringify({ ...settings, crossSessionInbound: "accept" }, null, 2) + "\n"
  try {
    mkdirSync(dirname(file), { recursive: true })
    let backup: string | undefined
    if (existsSync(file)) {
      backup = `${file}.bak-${now().toISOString().replace(/[:.]/g, "-")}`
      copyFileSync(file, backup)
    }
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, after)
    renameSync(tmp, file)
    return { file, status: "added", ...(backup ? { backup } : {}), diff: lineDiff(before, after) }
  } catch (err) {
    return { file, status: "failed", error: err instanceof Error ? err.message : String(err) }
  }
}

function renderFix(fix: CrossSessionInboundFix): string {
  if (fix.status === "failed") return `\nfix: crossSessionInbound NOT changed: ${fix.error}\n`
  if (fix.status === "already-set") {
    return `\nfix: ${fix.file} already sets crossSessionInbound to "${fix.current}"; nothing changed\n`
  }
  return (
    `\nfix: set crossSessionInbound to "accept" in ${fix.file}\n` +
    (fix.backup ? `     backup: ${fix.backup}\n` : "") +
    `${fix.diff}\n`
  )
}

function renderHookPathFix(p: { file: string; diff: string }): string {
  return (
    `\nfix: the \`agentproto hook\` commands in ${p.file} do not resolve in your login shell PATH.\n` +
    `     Proposed change, NOT written (apply it yourself, or export the PATH instead):\n${p.diff}\n`
  )
}

export interface DoctorJson {
  version: string
  platform: string
  steps: StepReport[]
  summary: ReportSummary
  fix?: CrossSessionInboundFix
  /** Proposed hook command change when `--fix` is given and the hook PATH
   *  check warned. Never written. */
  hookPathFix?: { file: string; absolute: string; diff: string }
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
  hookBinLookup: realHookBinLookup,
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
        fix: { type: "boolean" },
        only: { type: "string", multiple: true },
        skip: { type: "string", multiple: true },
      },
    }))
  } catch (err) {
    deps.stderr.write(`agentproto doctor: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
    return 2
  }
  const known = new Set([...deps.steps.map((s) => s.id), HOOK_STEP_ID])
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
  const settingsFile =
    deps.claudeSettingsFile ?? join(deps.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json")
  const hookRun =
    deps.hookBinLookup &&
    !(values.skip ?? []).includes(HOOK_STEP_ID) &&
    (!values.only || values.only.includes(HOOK_STEP_ID))
      ? await checkHookPath(settingsFile, deps.hookBinLookup)
      : undefined
  if (hookRun?.report) reports.push(hookRun.report)
  const hookPathFix = values.fix ? hookRun?.proposal : undefined
  const meta = { version: ctx.cliVersion, platform: `${ctx.platform}/${ctx.arch}` }

  const fix = values.fix
    ? applyCrossSessionInboundFix(settingsFile)
    : undefined

  if (values.json) {
    const json: DoctorJson = { ...meta, steps: reports, summary: summarize(reports), ...(fix ? { fix } : {}), ...(hookPathFix ? { hookPathFix } : {}) }
    deps.stdout.write(JSON.stringify(json, null, 2) + "\n")
  } else {
    const color = deps.stdout.isTTY === true && deps.env.NO_COLOR === undefined
    deps.stdout.write(renderHuman(reports, meta, color))
    if (fix) deps.stdout.write(renderFix(fix))
    if (hookPathFix) deps.stdout.write(renderHookPathFix(hookPathFix))
  }
  return hasRequiredFailure(reports) || fix?.status === "failed" ? 1 : 0
}
