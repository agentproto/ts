/**
 * `agentproto setup <slug>` + `runSetup()` engine.
 *
 * Implements AIP-29 § Setup — the post-install configuration pipeline.
 * Steps run in declared order. Idempotency comes from three layers:
 *
 *   1. Manifest's `version_check` — already covered by `install`. If the
 *      binary's version answers, install steps are skipped entirely
 *      before setup ever runs.
 *
 *   2. Per-step `skip_if.cmd` — runs first; matching exit code skips
 *      the step. Asks the live system, so it works on fresh machines
 *      without any local state.
 *
 *   3. Setup ledger — `~/.agentproto/setup/<slug>.json`, records each
 *      successful step with timestamp + (when applicable) which slot
 *      received the value. Re-runs short-circuit ledger-known steps
 *      unless --force is passed.
 *
 * The `runSetup()` export is what `agentproto install` calls after the
 * install array succeeds; `runSetupCommand()` is the standalone verb
 * (re-runs only setup, no install).
 *
 * Step `kind` matrix (current support):
 *
 *   - cmd       ✓ — shell command, optional skip_if + persist (stdout)
 *   - prompt    ✓ — text / boolean / select / secret; persist via env / secret_slug / cmd
 *   - oauth     ✗ — placeholder; needs a SECRETS.md driver wire-up
 *   - external  ⚠ — opens URL via xdg-open/open; callback polling not yet wired
 *
 * The unsupported kinds surface a clear "not yet implemented" message
 * so adapter authors can lean on cmd + prompt today and migrate later.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import type { AgentCliHandle } from "@agentproto/driver-agent-cli"
import { resolveAdapter } from "../registry/resolve.js"
import { runSteps } from "../lib/setup-prompts.js"

export interface RunSetupOptions {
  slug: string
  handle: AgentCliHandle
  /** When true, ignore the ledger AND skip_if; re-runs every step. */
  force?: boolean
  /** When true, log what would happen but don't spawn / prompt. */
  dryRun?: boolean
  /** When set, only run the named step ids (in declared order). Useful
   *  for re-running a single step after a manual fix. */
  only?: string[]
}

export async function runSetup(opts: RunSetupOptions): Promise<number> {
  const steps = opts.handle.setup ?? []
  if (steps.length === 0) {
    process.stdout.write(`agentproto setup: no setup steps for '${opts.slug}'.\n`)
    return 0
  }

  const code = await runSteps({
    ledgerPath: ledgerPathFor(opts.slug),
    slug: opts.slug,
    steps,
    force: opts.force,
    dryRun: opts.dryRun,
    only: opts.only,
  })

  if (code === 0) {
    process.stdout.write(`agentproto: setup for '${opts.slug}' complete.\n`)
  }
  return code
}

/**
 * `agentproto setup <slug>` — re-run the setup pipeline for an
 * already-installed bundle. Useful when adding new steps to an
 * adapter, fixing a broken step, or after a `--skip-setup` install.
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

// ── ledger path ───────────────────────────────────────────────────────

function ledgerPathFor(slug: string): string {
  const base = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  return join(base, "setup", `${slug}.json`)
}
