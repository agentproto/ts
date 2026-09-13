/**
 * `agentproto app init <template> [dir]`
 * `agentproto app validate [dir] [--json]`
 *
 * INIT wraps `create-agentproto-app`'s `scaffoldApp` (the same op `pnpm
 * create agentproto-app` drives) so an app can be bootstrapped without a
 * second package install. The `trame` template emits the minimal AIP app
 * trame — one agent, one workflow (a harness-pinned agent step with a
 * `promptFile`, then one `kind: gate` step), a single-file UI stage board,
 * `gates/example.mjs`, `scripts/verify.mjs`, `data/DATA.md`, and a
 * `node:test` suite — everything `app validate` knows how to check.
 *
 * VALIDATE is the read-side counterpart: load the app with
 * `@agentproto/app-kit`'s `loadAppHandle` (which itself loads every
 * AGENT.md and re-runs `defineApp`), load every declared WORKFLOW.md with
 * `@agentproto/workflow-loader` (harness/promptFile/gate blocks validated
 * by the loader), check each `ui.tools` entry against the known daemon
 * tool surface (below), require `data/DATA.md` when a `data.dir` is
 * declared, and finally run the APP.md `verify.command` (argv split, NO
 * shell, cwd = app dir, 10-minute cap) — propagating its exit code and
 * printing its stdout. `--json` prints `{ ok, findings: [{scope, level,
 * message}] }` for machines; exit 0 iff `ok`.
 */

import { readFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { isAbsolute, join, resolve } from "node:path"
import { parseArgs } from "node:util"

import matter from "gray-matter"
import { scaffoldApp } from "create-agentproto-app/scaffold"
import { loadAppHandle } from "@agentproto/app-kit"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"

import { pathExists } from "./skill-install/shared.js"
import { expandHome } from "./skill-install/pack-resolve.js"

// ── constants ────────────────────────────────────────────────────────────

/** Cap on the verify command (10 minutes) — mirrors a workflow gate's
 *  generous-but-bounded timeout. */
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000

/**
 * The known daemon tool names a `ui.tools` allowlist may name besides the
 * `app_*` family (which is accepted wholesale — app tools evolve together).
 * This is a documented static list in the CLI: the daemon registers its
 * full surface dynamically and exports no authoritative name list today.
 * It covers the orchestration/session surface an app UI or app agent
 * typically reaches (see `packages/runtime/src/orchestrator-gateway.ts`
 * `DEFAULT_ORCHESTRATOR_TOOLS` and `DEFAULT_ALWAYS_ON_TOOLS` in
 * `packages/runtime/src/index.ts`); genuinely app-scoped tools are all
 * `app_*` and need no entry here.
 */
const KNOWN_NON_APP_TOOLS: readonly string[] = [
  "agent_start",
  "agent_prompt",
  "agent_output",
  "agent_kill",
  "agent_export",
  "session_list",
  "session_monitor",
  "session_events_poll",
  "session_tree",
  "session_set_keepalive",
  "message_parent",
  "command_execute",
  "permissions_list",
  "permissions_respond",
  "task_create",
  "task_list",
  "task_claim",
  "task_update",
  "daemon_health",
  // Reached by app UIs through the served stage board (/agentproto/stageboard.js):
  // Approve resolves a parked approval step via the escalation seam.
  "workflow_escalation_resolve",
  "workflow_status",
]

function isKnownUiTool(name: string): boolean {
  return name.startsWith("app_") || KNOWN_NON_APP_TOOLS.includes(name)
}

const KNOWN_STEP_KINDS: readonly string[] = [
  "agent",
  "gate",
  "tool",
  "branch",
  "parallel",
  "suspend",
  "approval",
  "map",
  "loop",
  "subworkflow",
]

/**
 * The workflow-loader's frontmatter schema accepts `steps: z.array(z.any())`
 * (the AIP-15 JSON Schema doesn't close the step union either), so an
 * unknown `kind` sails through `loadWorkflowHandle`. Validate checks the
 * kinds itself, walking nested step lists (map/loop bodies, parallel
 * branches). Returns the first unknown kind with its step path.
 */
function findUnknownStepKind(
  steps: readonly unknown[],
  path: string,
): { kind: string; path: string } | undefined {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const at = `${path}[${i}]`
    const kind =
      typeof step === "object" &&
      step !== null &&
      "kind" in step &&
      typeof step.kind === "string"
        ? step.kind
        : undefined
    if (kind === undefined || !KNOWN_STEP_KINDS.includes(kind)) {
      return { kind: kind ?? "(missing)", path: at }
    }
    if (typeof step !== "object" || step === null) continue
    if ("steps" in step && Array.isArray(step.steps)) {
      const nested = findUnknownStepKind(step.steps, `${at}.steps`)
      if (nested !== undefined) return nested
    }
    if ("branches" in step && Array.isArray(step.branches)) {
      for (let b = 0; b < step.branches.length; b++) {
        const branch = step.branches[b]
        if (
          typeof branch === "object" &&
          branch !== null &&
          "steps" in branch &&
          Array.isArray(branch.steps)
        ) {
          const nested = findUnknownStepKind(
            branch.steps,
            `${at}.branches[${b}].steps`,
          )
          if (nested !== undefined) return nested
        }
      }
    }
  }
  return undefined
}

const USAGE = `agentproto app init / validate — scaffold an app from a template, then check it

Usage:
  agentproto app init <template> [dir]
  agentproto app validate [dir] [--json]

init:
  Scaffold <dir> (default: the current directory) from <template> —
  react-ts | vanilla | book | trame. Refuses a non-empty target.
  'trame' emits the minimal AIP app trame: one agent, one workflow
  (agent step + gate), a single-file UI, an example gate, the verify
  umbrella, the data-plane dictionary, and a node:test suite.

validate:
  Check [dir] (default: the current directory) against the app loader:
  APP.md loads, every declared workflow loads, every ui.tools entry is a
  known daemon tool (or app_*), data/DATA.md exists when data.dir is
  declared, and the APP.md verify.command (if any) exits 0 — its stdout is
  printed and its exit code propagated. --json prints
  {ok, findings: [{scope, level, message}]}. Exit 0 iff ok.`

// ── frontmatter narrowing (tolerant — unknown keys never fail) ──────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

interface AppFrontmatterDigest {
  readonly workflows: ReadonlyArray<{ readonly id: string; readonly path: string }>
  readonly uiTools: readonly string[] | undefined
  readonly dataDir: string | undefined
  readonly verifyCommand: string | undefined
}

/**
 * Digest the APP.md frontmatter for validate's own checks. Returns
 * `undefined` when APP.md is missing/unparseable — `loadAppHandle` has
 * already produced the authoritative error finding for that case.
 */
async function readFrontmatter(
  appDir: string,
): Promise<AppFrontmatterDigest | undefined> {
  const appMdPath = join(appDir, ".agentproto", "APP.md")
  let raw: string
  try {
    raw = await readFile(appMdPath, "utf8")
  } catch {
    return undefined
  }
  let data: unknown
  try {
    data = matter(raw).data
  } catch {
    return undefined
  }
  if (!isRecord(data)) return undefined

  const workflows: { id: string; path: string }[] = []
  if (Array.isArray(data.workflows)) {
    for (const entry of data.workflows) {
      if (!isRecord(entry)) continue
      const id = asString(entry.id)
      const path = asString(entry.path)
      if (id !== undefined && path !== undefined) workflows.push({ id, path })
    }
  }

  let uiTools: string[] | undefined
  const ui = data.ui
  if (isRecord(ui) && Array.isArray(ui.tools)) {
    uiTools = ui.tools.filter((t): t is string => typeof t === "string")
  }

  let dataDir: string | undefined
  const declaredData = data.data
  if (isRecord(declaredData)) dataDir = asString(declaredData.dir)

  let verifyCommand: string | undefined
  const verify = data.verify
  if (isRecord(verify)) verifyCommand = asString(verify.command)

  return { workflows, uiTools, dataDir, verifyCommand }
}

// ── app init ─────────────────────────────────────────────────────────────

/** Dispatcher for `agentproto app init <template> [dir]`. */
export async function runAppInit(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
    },
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const template = positionals[0]
  if (!template) {
    process.stderr.write(
      `agentproto app init: <template> is required (react-ts | vanilla | book | trame).\n${USAGE}\n`,
    )
    return 2
  }
  const dirArg = positionals[1] ?? "."

  const outcome = await scaffoldApp({
    targetDir: resolve(process.cwd(), expandHome(dirArg)),
    template,
  })

  if (!outcome.ok) {
    process.stderr.write(`agentproto app init: ${outcome.message}\n`)
    return 2
  }

  const r = outcome.result
  process.stdout.write(
    `agentproto: scaffolded '${r.id}' (${r.template}) -> ${r.appDir}\n` +
      `  ${r.fileCount} file(s)\n` +
      `Next: agentproto app validate ${dirArg}\n`,
  )
  return 0
}

// ── app validate ─────────────────────────────────────────────────────────

interface Finding {
  readonly scope: string
  readonly level: "error" | "warning"
  readonly message: string
}

/** Dispatcher for `agentproto app validate [dir] [--json]`. */
export async function runAppValidate(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const dirArg = positionals[0] ?? "."
  const appDir = resolve(process.cwd(), expandHome(dirArg))

  const findings: Finding[] = []

  // 1. The app loader is authoritative for APP.md + agents + workflows +
  //    the defineApp attachment invariant.
  let appLoaded = false
  try {
    await loadAppHandle(appDir)
    appLoaded = true
  } catch (err) {
    findings.push({
      scope: "app",
      level: "error",
      message: err instanceof Error ? err.message : String(err),
    })
  }

  const fm = await readFrontmatter(appDir)

  // 2. Every declared workflow must load (the loader validates harness
  //    blocks, promptFile resolution, and gate steps).
  let verifyCommand: string | undefined
  if (fm !== undefined) {
    for (const ref of fm.workflows) {
      const wfPath = isAbsolute(ref.path) ? ref.path : join(appDir, ref.path)
      try {
        const handle = await loadWorkflowHandle(wfPath)
        const badKind = findUnknownStepKind(handle.steps, "steps")
        if (badKind !== undefined) {
          findings.push({
            scope: `workflow:${ref.id}`,
            level: "error",
            message:
              `${wfPath}: unknown step kind '${badKind.kind}' at ${badKind.path} ` +
              `(known: ${KNOWN_STEP_KINDS.join(", ")}).`,
          })
        }
      } catch (err) {
        findings.push({
          scope: `workflow:${ref.id}`,
          level: "error",
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // 3. ui.tools entries must be known daemon tools or app_*.
    if (fm.uiTools !== undefined) {
      for (const tool of fm.uiTools) {
        if (!isKnownUiTool(tool)) {
          findings.push({
            scope: "ui.tools",
            level: "error",
            message:
              `unknown tool '${tool}' — ui.tools entries must be app_* ` +
              `tools or known daemon tools (${KNOWN_NON_APP_TOOLS.join(", ")}).`,
          })
        }
      }
    }

    // 4. A declared data dir must carry its DATA.md key dictionary.
    if (fm.dataDir !== undefined) {
      const dataMd = join(appDir, fm.dataDir, "DATA.md")
      if (!(await pathExists(dataMd))) {
        findings.push({
          scope: "data",
          level: "error",
          message: `data.dir '${fm.dataDir}' is declared but ${dataMd} is missing.`,
        })
      }
    }

    verifyCommand = fm.verifyCommand
  }

  // 5. The verify umbrella — run last, only if the frontmatter was readable.
  let verifyExit: number | null = null
  if (appLoaded && verifyCommand !== undefined) {
    const argv = verifyCommand.trim().split(/\s+/)
    const run = await runVerify(appDir, argv)
    verifyExit = run.exitCode
    if (run.stdout.trim() !== "") {
      process.stdout.write(run.stdout)
    }
    if (run.timedOut) {
      findings.push({
        scope: "verify",
        level: "error",
        message: `verify command timed out after ${VERIFY_TIMEOUT_MS}ms.`,
      })
    } else if (verifyExit !== 0) {
      findings.push({
        scope: "verify",
        level: "error",
        message: `verify command exited with code ${verifyExit}.`,
      })
    }
  }

  const ok = findings.every((f) => f.level !== "error")

  if (values.json) {
    process.stdout.write(JSON.stringify({ ok, findings }, null, 2) + "\n")
  } else if (ok) {
    process.stdout.write(
      `agentproto: ${appDir} is a valid agentproto app` +
        (verifyExit !== null ? ` (verify exit 0)\n` : "\n"),
    )
  } else {
    for (const f of findings) {
      process.stderr.write(`[${f.level}] ${f.scope}: ${f.message}\n`)
    }
    process.stderr.write(
      `agentproto: ${appDir} has ${findings.length} finding(s).\n`,
    )
  }

  if (!ok) {
    // Propagate the verify command's own exit code when it is the sole
    // failure; anything else is a validate finding (exit 1).
    if (
      verifyExit !== null &&
      verifyExit !== 0 &&
      findings.every((f) => f.scope === "verify")
    ) {
      return verifyExit
    }
    return 1
  }
  return 0
}

/**
 * Run the verify command as an argv vector — no shell — with cwd = appDir,
 * a 10-minute cap, and captured stdout. Returns the real exit code (1 on
 * spawn failure or timeout, with `timedOut` distinguishing the latter).
 */
function runVerify(
  cwd: string,
  argv: readonly string[],
): Promise<{ exitCode: number; stdout: string; timedOut: boolean }> {
  return new Promise((resolveRun) => {
    const child = spawn(argv[0] ?? "", argv.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let timedOut = false
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, VERIFY_TIMEOUT_MS)
    child.once("error", () => {
      clearTimeout(timer)
      resolveRun({ exitCode: 1, stdout, timedOut: false })
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      resolveRun({ exitCode: timedOut ? 1 : code ?? 0, stdout, timedOut })
    })
  })
}
