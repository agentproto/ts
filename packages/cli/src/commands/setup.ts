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
} from "@agentproto/adapter-kit"
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
 * Execute one `AgentCliSetupStep`. Injected into the wizard as `runStep`.
 * The wizard handles ledger-skip and `force`; this function handles `skip_if`
 * and the actual cmd / prompt / external / oauth execution.
 *
 * `force` is closed over from `RunSetupOptions` so `skip_if` is bypassed
 * consistently with the old `runSteps` behaviour.
 */
function makeAgentCliStepRunner(force: boolean | undefined) {
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
    runStep: makeAgentCliStepRunner(opts.force),
    log: (msg) => process.stdout.write(msg + "\n"),
  })

  return wizard.run({
    force: opts.force,
    dryRun: opts.dryRun,
    only: opts.only,
  })
}

/**
 * `agentproto setup <slug>` — re-run the setup pipeline for an
 * already-installed bundle.
 */
export async function runSetupCommand(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      force: { type: "boolean", short: "f" },
      "dry-run": { type: "boolean" },
      only: { type: "string", multiple: true },
    },
  })
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
