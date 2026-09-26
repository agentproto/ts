/**
 * `agentproto setup <slug>` + `runSetup()` engine.
 *
 * Implements AIP-29 § Setup — the post-install configuration pipeline.
 * Step iteration is delegated to the kit's `makeAdapterWizard`; the
 * family-specific step runner (cmd / prompt / external / oauth kinds) is
 * injected into the wizard as `runStep`.
 *
 * Idempotency layers:
 *   1. Per-step `skip_if.cmd` — runs first; matching exit code skips the step.
 *   2. Setup ledger — `~/.agentproto/setup/<slug>.json`; kit's `makeSetupLedger`
 *      is used for both the lister's status computation and the wizard's
 *      step-skip tracking. A compat shim normalises any pre-migration files
 *      that use the older `steps: Record<id, LedgerEntry>` format.
 *
 * `runSetup()` — programmatic API (called from `agentproto install` post-install).
 * `runSetupCommand()` — CLI verb (`agentproto setup <slug>`).
 */

import { homedir } from "node:os"
import { platform } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { spawn } from "node:child_process"
import type { AgentCliHandle, AgentCliSetupStep, AgentCliSetupSkipIf } from "@agentproto/driver-agent-cli"
import {
  makeAdapterWizard,
  makeSetupLedger,
  type AdapterHandle,
  type SetupLedger,
  type SetupLedgerRecord,
  type AdapterWizardStep,
  type WizardStepResult,
} from "@agentproto/provider-kit"
import { resolveAdapter } from "../registry/resolve.js"
import { CATALOG } from "../registry/catalog.js"
import {
  runShellCapturing,
  promptString,
  promptBoolean,
  promptSelect,
  applyPersist,
  type Ledger,
} from "../lib/setup-prompts.js"
// Type-only: the onboarding modules import `install.ts`, which imports this
// file — they are loaded lazily inside the wizard branch to keep that cycle
// out of module evaluation.
import type { WizardDeps } from "../onboarding/wizard.js"

// ── Handle wrapper ────────────────────────────────────────────────────────────

/** `AgentCliHandle` wrapped to satisfy `AdapterHandle` for the wizard. */
interface AgentCliSetupHandle extends AdapterHandle {
  readonly originalHandle: AgentCliHandle
}

function wrapForSetup(slug: string, handle: AgentCliHandle): AgentCliSetupHandle {
  const h = handle as Record<string, unknown>
  return {
    slug,
    name: typeof h.name === "string" ? h.name : slug,
    version: typeof h.version === "string" ? h.version : "?",
    description: typeof h.description === "string" ? h.description : "",
    requiresSetup: Array.isArray(h.setup) && (h.setup as unknown[]).length > 0,
    check: async () => false,
    originalHandle: handle,
  }
}

// ── Ledger compat shim ────────────────────────────────────────────────────────

/**
 * Wraps `makeSetupLedger` with a reader that normalises pre-migration ledger
 * files (steps was `Record<id, LedgerEntry>`) to the kit's array format.
 * After one wizard run the file is rewritten in the new format.
 */
function makeCliSetupLedger(): SetupLedger {
  const base = makeSetupLedger()
  return {
    ...base,
    async read(slug: string): Promise<SetupLedgerRecord | null> {
      const raw = await base.read(slug)
      if (!raw) return null
      // Old format: steps was a plain object keyed by step id.
      if (raw.steps && !Array.isArray(raw.steps)) {
        const stepsObj = raw.steps as unknown as Record<string, { completedAt?: string }>
        return {
          slug: raw.slug,
          completedAt: raw.completedAt ?? (raw as unknown as { updatedAt?: string }).updatedAt ?? "",
          steps: Object.entries(stepsObj).map(([id, entry]) => ({
            id,
            completedAt: entry.completedAt ?? raw.completedAt ?? "",
          })),
        }
      }
      return raw
    },
  }
}

// ── Family-specific step runner ───────────────────────────────────────────────

async function checkSkipIf(skip: AgentCliSetupSkipIf): Promise<boolean> {
  const { exitCode } = await runShellCapturing(skip.cmd, {
    timeoutMs: skip.timeout_ms ?? 5_000,
    interactive: false,
  })
  return exitCode === (skip.exit_code ?? 0)
}

/**
 * Distinct exit code for "a setup step needs an interactive terminal and
 * this process has none". Lets programmatic hosts (the daemon's
 * adapter_install path) tell "setup is blocked on a human in a TTY" apart
 * from a genuinely failed setup, instead of both collapsing into exit 1 —
 * the openclaw incident: its clack-style `onboard --install-daemon` TUI,
 * run under the TTY-less daemon, silently defaulted its confirm to "No"
 * and died as an inscrutable `exit 1`.
 */
export const EXIT_SETUP_NEEDS_TTY = 78 // sysexits EX_CONFIG

/**
 * Execute one `AgentCliSetupStep`. Injected into the wizard as `runStep`.
 * The wizard handles ledger-skip and `force`; this function handles `skip_if`
 * and the actual cmd / prompt / external / oauth execution.
 *
 * `force` is closed over from `RunSetupOptions` so `skip_if` is bypassed
 * consistently with the old `runSteps` behaviour.
 *
 * `blocked` is an out-param: set when an `interactive: true` cmd step was
 * refused because stdin is not a TTY — running a TUI against a pipe can
 * only hang or die on its own defaults, never succeed.
 */
function makeAgentCliStepRunner(force: boolean | undefined, blocked?: { onInteractiveNoTty: boolean }) {
  return async function agentCliRunStep(
    handle: AgentCliSetupHandle,
    step: AdapterWizardStep,
    ctx: { dryRun: boolean }
  ): Promise<WizardStepResult> {
    const fullSteps: AgentCliSetupStep[] = (handle.originalHandle as Record<string, unknown>).setup as AgentCliSetupStep[] ?? []
    const fullStep = fullSteps.find((s) => s.id === step.id)
    if (!fullStep) return { ok: false }

    // skip_if is checked before execution (bypassed when force=true).
    if (fullStep.skip_if && !force && !ctx.dryRun) {
      const shouldSkip = await checkSkipIf(fullStep.skip_if)
      if (shouldSkip) {
        process.stdout.write(`setup: ${fullStep.id}: skip_if matched — skipping\n`)
        return { ok: true }
      }
    }

    if (ctx.dryRun) return { ok: true }

    // Accumulator for env-bound values (audit/persist only; not re-consumed at runtime).
    const envAcc: Ledger = { slug: handle.slug, updatedAt: "", steps: {} }

    switch (fullStep.kind) {
      case "cmd": {
        if (fullStep.interactive && process.stdin.isTTY !== true) {
          process.stderr.write(
            `setup: ${fullStep.id}: needs an interactive terminal (stdin is not a TTY here) — ` +
              `run \`agentproto setup ${handle.slug}\` in a real terminal to complete it.\n`
          )
          if (blocked) blocked.onInteractiveNoTty = true
          return { ok: false }
        }
        if (fullStep.description) process.stdout.write(`setup: ${fullStep.description}\n`)
        process.stdout.write(`setup: $ ${fullStep.cmd}\n`)
        const captured = await runShellCapturing(fullStep.cmd, {
          timeoutMs: fullStep.timeout_ms ?? 60_000,
          interactive: fullStep.interactive ?? false,
        })
        if (captured.exitCode !== 0) {
          process.stderr.write(
            `setup: ${fullStep.id}: cmd exited ${captured.exitCode}` +
              (captured.stderr ? ": " + captured.stderr.slice(0, 400) : "") + "\n"
          )
          return { ok: false }
        }
        if (fullStep.persist) {
          await applyPersist(fullStep.persist, captured.stdout.trim(), envAcc)
        }
        return { ok: true }
      }

      case "prompt": {
        if (fullStep.description) process.stdout.write(`setup: ${fullStep.description}\n`)
        const type = fullStep.type ?? "text"
        let value: string
        switch (type) {
          case "text":
          case "secret":
            value = await promptString(fullStep.prompt, {
              masked: type === "secret",
            })
            break
          case "boolean":
            value = (await promptBoolean(fullStep.prompt, fullStep.default === "true")) ? "true" : "false"
            break
          case "select": {
            const options = await resolveSelectOptions(fullStep.options)
            if (options.length === 0) {
              process.stderr.write(`setup: ${fullStep.id}: select prompt has no options\n`)
              return { ok: false }
            }
            value = await promptSelect(fullStep.prompt, options, fullStep.default)
            break
          }
          default:
            value = ""
        }
        if (fullStep.persist) {
          await applyPersist(fullStep.persist, value, envAcc)
        }
        return { ok: true }
      }

      case "external": {
        if (fullStep.description) process.stdout.write(`setup: ${fullStep.description}\n`)
        process.stdout.write(`setup: opening ${fullStep.url}\n`)
        const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open"
        const args = platform() === "win32" ? ["/c", "start", fullStep.url] : [fullStep.url]
        await new Promise<void>((resolve) => {
          const child = spawn(opener, args, { stdio: "ignore", detached: true })
          child.once("error", () => resolve())
          child.once("spawn", () => resolve())
        })
        let value = ""
        if (fullStep.callback?.param) {
          value = await promptString(
            `Paste the value of '${fullStep.callback.param}' from the redirect`,
            { masked: false }
          )
        } else {
          process.stdout.write(`setup: ${fullStep.id}: done — press Enter when finished.\n`)
          await promptString("(press Enter to continue)", { masked: false })
        }
        if (fullStep.persist && value) {
          await applyPersist(fullStep.persist, value, envAcc)
        }
        return { ok: true }
      }

      case "oauth":
        process.stderr.write(
          `setup: ${fullStep.id}: kind=oauth is not yet implemented in the local CLI host.\n`
        )
        return { ok: false }
    }
  }
}

async function resolveSelectOptions(
  options: Extract<AgentCliSetupStep, { kind: "prompt" }>["options"]
): Promise<{ value: string; label?: string }[]> {
  if (!options) return []
  if (Array.isArray(options)) return options.map((v) => ({ value: v }))
  const captured = await runShellCapturing(options.cmd, {
    timeoutMs: options.timeout_ms ?? 30_000,
    interactive: false,
  })
  if (captured.exitCode !== 0) {
    throw new Error(`select options cmd exited ${captured.exitCode}`)
  }
  return captured.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, label] = line.split("\t")
      const out: { value: string; label?: string } = { value: value! }
      if (label) out.label = label
      return out
    })
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface RunSetupOptions {
  slug: string
  handle: AgentCliHandle
  /** When true, ignore the ledger AND skip_if; re-runs every step. */
  force?: boolean
  /** When true, log what would happen but don't spawn / prompt. */
  dryRun?: boolean
  /** When set, only run the named step ids (in declared order). */
  only?: string[]
}

export async function runSetup(opts: RunSetupOptions): Promise<number> {
  const wrappedHandle = wrapForSetup(opts.slug, opts.handle)
  const blocked = { onInteractiveNoTty: false }

  // Synthesise a single-entry catalog so the wizard auto-picks the slug.
  const catalogEntry = CATALOG.find((e) => e.slug === opts.slug) ?? {
    slug: opts.slug,
    name: wrappedHandle.name,
    description: wrappedHandle.description,
    packageName: `@agentproto/adapter-${opts.slug}`,
  }

  const ledger = makeCliSetupLedger()

  const wizard = makeAdapterWizard<AgentCliSetupHandle, never>({
    catalog: [catalogEntry],
    resolver: async (slug) => (slug === opts.slug ? wrappedHandle : null),
    ledger,
    getSteps: (h) =>
      ((h.originalHandle as Record<string, unknown>).setup as AgentCliSetupStep[] ?? []).map(
        (s): AdapterWizardStep => ({
          id: s.id,
          // "oauth" is not a valid AdapterWizardStep kind; map to "external" so the
          // wizard includes it in its iteration. The runner handles "oauth" explicitly.
          kind: s.kind === "oauth" ? "external" : s.kind,
          label: (s as { description?: string }).description ?? s.id,
          secret:
            s.kind === "prompt" && (s as Extract<AgentCliSetupStep, { kind: "prompt" }>).type === "secret",
        })
      ),
    runStep: makeAgentCliStepRunner(opts.force, blocked),
    log: (msg) => process.stdout.write(msg + "\n"),
  })

  const code = await wizard.run({
    force: opts.force,
    dryRun: opts.dryRun,
    only: opts.only,
  })
  // The blocked-on-TTY refusal is a distinct outcome, not a plain failure —
  // programmatic hosts key off this code to offer a real terminal instead.
  if (code !== 0 && blocked.onInteractiveNoTty) return EXIT_SETUP_NEEDS_TTY
  return code
}

const USAGE = `agentproto setup — set up agentproto on this machine, or re-run one adapter's setup

Usage:
  agentproto setup [--yes] [--dry-run] [--json] [--only <step>...] [--skip <step>...]
      the onboarding wizard: detect (same checks as \`agentproto doctor\`), propose,
      apply through the existing verbs, verify. Re-running resumes: done steps are skipped.
      Steps: preflight, workspace, daemon, agents, auth, clients, skills, local-models, first-run

  agentproto setup <slug> [--force] [--dry-run] [--only <stepId>...]
      re-run an adapter's AIP-29 setup pipeline (idempotent via skip_if + ledger)

Wizard flags:
  --yes           apply the defaults without prompting (never applies secrets)
  --dry-run       show what would be proposed, change nothing
  --json          print the final report (doctor JSON + applied actions) on stdout
  --only <step>   run only this step (repeatable)
  --skip <step>   skip this step (repeatable)

Examples:
  agentproto setup                         # guided first run
  agentproto setup --yes --skip first-run  # unattended, no test session
  agentproto setup openclaw                # re-run openclaw's adapter setup
`

/** Injected for tests; real ones build the clack UI + real verbs. */
export interface SetupWizardCommandDeps {
  /** stdin and stdout are both terminals. */
  isTTY: boolean
  build(opts: { interactive: boolean; json: boolean }): Promise<WizardDeps>
  stderr: { write(chunk: string): unknown }
}

async function realWizardDeps(opts: { interactive: boolean; json: boolean }): Promise<WizardDeps> {
  const [{ createSetupIO }, { createStepContext }, { ONBOARDING_STEPS, SETUP_STEPS }] = await Promise.all([
    import("../onboarding/setup-io.js"),
    import("../onboarding/context.js"),
    import("../onboarding/registry.js"),
  ])
  const cwd = process.cwd()
  const { io, ui, runtime } = createSetupIO({ ...opts, cwd })
  const version = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0-dev"
  return { ctx: createStepContext(version), io, ui, steps: SETUP_STEPS, doctorSteps: ONBOARDING_STEPS, ...runtime }
}

const REAL_WIZARD_DEPS: SetupWizardCommandDeps = {
  isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  build: realWizardDeps,
  stderr: process.stderr,
}

/**
 * `agentproto setup` with no slug — the onboarding wizard. Also the target of
 * the `agentproto onboard` alias, whose `--skills <slug>` / `--agent <name>`
 * narrow the skill and MCP-registration actions.
 */
export async function runSetupWizardCommand(
  args: readonly string[],
  deps: SetupWizardCommandDeps = REAL_WIZARD_DEPS,
): Promise<number> {
  let values: {
    yes?: boolean
    "dry-run"?: boolean
    json?: boolean
    only?: string[]
    skip?: string[]
    skills?: string
    agent?: string[]
  }
  try {
    ;({ values } = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      options: {
        yes: { type: "boolean", short: "y" },
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
        only: { type: "string", multiple: true },
        skip: { type: "string", multiple: true },
        skills: { type: "string" },
        agent: { type: "string", multiple: true },
      },
    }))
  } catch (err) {
    deps.stderr.write(`agentproto setup: ${err instanceof Error ? err.message : String(err)}\n  See: agentproto setup --help\n`)
    return 2
  }
  const { SETUP_STEPS } = await import("../onboarding/registry.js")
  const known = new Set(SETUP_STEPS.map((s) => s.id))
  const unknown = [...(values.only ?? []), ...(values.skip ?? [])].filter((id) => !known.has(id))
  if (unknown.length > 0) {
    deps.stderr.write(`agentproto setup: unknown step(s): ${unknown.join(", ")}. Known: ${[...known].join(", ")}\n`)
    return 2
  }
  const yes = values.yes === true
  const dryRun = values["dry-run"] === true
  if (!yes && !dryRun && !deps.isTTY) {
    deps.stderr.write(
      "agentproto setup: no interactive terminal. Re-run with --yes to apply the defaults " +
        "(secrets are never applied unattended), or --dry-run to see the plan.\n",
    )
    return EXIT_SETUP_NEEDS_TTY
  }

  const wizardDeps = await deps.build({ interactive: !yes && !dryRun && deps.isTTY, json: values.json === true })
  const verbs = wizardDeps.io.verbs
  const skillSlug = values.skills
  const agents = values.agent
  const io = {
    ...wizardDeps.io,
    verbs: {
      ...verbs,
      // onboard --skills <slug>: install that skill instead of the pack.
      ...(skillSlug
        ? { installSkill: (_slug: string, a: readonly string[]) => verbs.installSkill(skillSlug.startsWith("skill/") ? skillSlug : `skill/${skillSlug}`, a) }
        : {}),
      // onboard --agent <name>…: register the MCP server with these clients only.
      ...(agents && agents.length > 0
        ? {
            installMcp: (a: readonly string[]) => {
              const kept: string[] = []
              for (let i = 0; i < a.length; i++) {
                const arg = a[i] ?? ""
                if (arg === "--agent") {
                  const name = a[i + 1] ?? ""
                  i++
                  if (agents.includes(name)) kept.push("--agent", name)
                } else kept.push(arg)
              }
              return a.includes("--agent") && !kept.includes("--agent") ? Promise.resolve(0) : verbs.installMcp(kept)
            },
          }
        : {}),
    },
  }
  const { runSetupWizard } = await import("../onboarding/wizard.js")
  const { code } = await runSetupWizard(
    {
      yes,
      dryRun,
      json: values.json === true,
      ...(values.only ? { only: values.only } : {}),
      ...(values.skip ? { skip: values.skip } : {}),
    },
    { ...wizardDeps, io },
  )
  return code
}

/** `setup` with a positional ⇒ adapter mode; without ⇒ the wizard. */
function hasSlugArg(args: readonly string[]): boolean {
  const { positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      only: { type: "string", multiple: true },
      skip: { type: "string", multiple: true },
      skills: { type: "string" },
      agent: { type: "string", multiple: true },
    },
  })
  return positionals.length > 0
}

/**
 * `agentproto setup` — no slug: the onboarding wizard; `setup <slug>`:
 * re-run the setup pipeline for an already-installed bundle.
 */
export async function runSetupCommand(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  if (!hasSlugArg(args)) return runSetupWizardCommand(args)
  let values: {
    force?: boolean
    "dry-run"?: boolean
    only?: string[]
  }
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        force: { type: "boolean", short: "f" },
        "dry-run": { type: "boolean" },
        only: { type: "string", multiple: true },
      },
    }))
  } catch (err) {
    // A friendly message on an unknown flag/arg instead of a raw parseArgs
    // stack — point at the help so callers can discover the supported set.
    process.stderr.write(
      `agentproto setup: ${err instanceof Error ? err.message : String(err)}\n` +
        "  See: agentproto setup --help\n"
    )
    return 2
  }
  const slug = positionals[0]
  if (!slug) {
    process.stderr.write(
      "agentproto setup: missing adapter slug. Try: agentproto setup openclaw\n"
    )
    return 2
  }
  const adapter = await resolveAdapter(slug)
  return runSetup({
    slug,
    handle: adapter.handle,
    force: values.force ?? false,
    dryRun: values["dry-run"] ?? false,
    ...(values.only ? { only: values.only } : {}),
  })
}

// ── ledger path helper (kept for backward compat; used by other callers) ────

export function ledgerPathFor(slug: string): string {
  const base = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  return join(base, "setup", `${slug}.json`)
}
