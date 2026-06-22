/**
 * CLI interactive wizard factory (§5). A radio chooser over the catalog,
 * then a per-family step runner. The picker UX and the ledger write are
 * shared; each family injects its own `getSteps` and step-execution hooks.
 *
 * Per §5, ledger-completed steps are SKIPPED unless `force=true`.
 *
 * The `select` (radio chooser) and `runStep` (per-step executor) hooks are
 * injectable so the kit stays dependency-light and unit-testable. Families
 * (or the CLI) wire a real implementation (e.g. @clack/prompts) at call time.
 */

import type { CredsStore } from "./creds-store.js"
import type { SetupLedger } from "./ledger.js"
import type {
  AdapterCatalog,
  AdapterCatalogEntry,
  AdapterHandle,
  AdapterResolver,
  SetupLedgerRecord,
} from "./types.js"

export interface AdapterWizardStep {
  id: string
  kind: "prompt" | "cmd" | "external"
  label: string
  /** When "prompt": the captured value is written to CredsStore or env. */
  secret?: boolean
}

/** Outcome of running a single step. */
export interface WizardStepResult {
  /** False aborts the wizard (returns non-zero). */
  ok: boolean
  /** For secret "prompt" steps: the captured creds value to persist. */
  value?: unknown
}

export interface MakeAdapterWizardOpts<THandle extends AdapterHandle, TCreds> {
  catalog: AdapterCatalog
  resolver: AdapterResolver<THandle>
  ledger: SetupLedger
  credsStore?: CredsStore<TCreds>
  /** Provide setup steps for a resolved handle. */
  getSteps: (handle: THandle) => AdapterWizardStep[]
  /**
   * Radio chooser. Receives the catalog, returns the chosen slug (or null
   * to cancel). Default-injected by the CLI; required for non-interactive
   * callers that pass `only`/a single-entry catalog can still rely on it.
   */
  select?: (catalog: AdapterCatalog) => Promise<string | null>
  /** Execute one step. Returns ok + optional captured value. */
  runStep?: (
    handle: THandle,
    step: AdapterWizardStep,
    ctx: { dryRun: boolean }
  ) => Promise<WizardStepResult>
  /** Optional logger for progress lines. */
  log?: (msg: string) => void
}

export interface WizardRunOpts {
  /** Re-run every step even if the ledger marks it complete. */
  force?: boolean
  /** Don't execute side effects or write the ledger; just report. */
  dryRun?: boolean
  /** Restrict to these step ids (and pin the slug when a single match). */
  only?: string[]
}

export interface AdapterWizard {
  /** Returns a process-style exit code (0 = success). */
  run(opts?: WizardRunOpts): Promise<number>
}

export function makeAdapterWizard<THandle extends AdapterHandle, TCreds>(
  opts: MakeAdapterWizardOpts<THandle, TCreds>
): AdapterWizard {
  const {
    catalog,
    resolver,
    ledger,
    credsStore,
    getSteps,
    select,
    runStep,
    log,
  } = opts
  const note = (msg: string): void => log?.(msg)

  async function pickSlug(catalogList: AdapterCatalog): Promise<string | null> {
    if (catalogList.length === 1) return catalogList[0]!.slug
    if (!select) {
      throw new Error(
        "makeAdapterWizard: no `select` chooser injected and the catalog has " +
          "multiple entries — provide opts.select to pick interactively."
      )
    }
    return select(catalogList)
  }

  return {
    async run(runOpts: WizardRunOpts = {}): Promise<number> {
      const { force = false, dryRun = false, only } = runOpts

      const slug = await pickSlug(catalog)
      if (!slug) {
        note("setup cancelled — no adapter chosen")
        return 1
      }

      const handle = await resolver(slug)
      if (!handle) {
        note(`setup: adapter '${slug}' is not installed — install it first`)
        return 1
      }

      let steps = getSteps(handle)
      if (only && only.length > 0) {
        const want = new Set(only)
        steps = steps.filter((s) => want.has(s.id))
      }

      // Skip ledger-completed steps unless force.
      const prior = await ledger.read(slug)
      const done = new Set((prior?.steps ?? []).map((s) => s.id))
      const toRun = force ? steps : steps.filter((s) => !done.has(s.id))

      if (toRun.length === 0) {
        note(`setup: '${slug}' already complete — nothing to do (use --force to re-run)`)
        return 0
      }

      const ranStepRecords: { id: string; completedAt: string }[] = []
      for (const step of toRun) {
        note(`${dryRun ? "[dry-run] " : ""}${slug}: ${step.label}`)
        if (!runStep) {
          if (dryRun) {
            ranStepRecords.push({ id: step.id, completedAt: nowIso() })
            continue
          }
          throw new Error(
            "makeAdapterWizard: no `runStep` executor injected — provide " +
              "opts.runStep to run setup steps."
          )
        }
        const result = await runStep(handle, step, { dryRun })
        if (!result.ok) {
          note(`setup: step '${step.id}' failed — aborting`)
          return 1
        }
        if (!dryRun && step.kind === "prompt" && step.secret && credsStore && result.value !== undefined) {
          await credsStore.write(slug, result.value as TCreds)
        }
        ranStepRecords.push({ id: step.id, completedAt: nowIso() })
      }

      if (dryRun) {
        note(`[dry-run] '${slug}': would mark ${ranStepRecords.length} step(s) complete`)
        return 0
      }

      // Merge prior + freshly-run step records, newest timestamp wins.
      const merged = new Map<string, { id: string; completedAt: string }>()
      for (const s of prior?.steps ?? []) merged.set(s.id, s)
      for (const s of ranStepRecords) merged.set(s.id, s)
      const record: SetupLedgerRecord = {
        slug,
        completedAt: nowIso(),
        steps: [...merged.values()],
      }
      await ledger.write(slug, record)
      note(`setup: '${slug}' complete`)
      return 0
    },
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

// Re-export the catalog-entry type for convenience in family wizards.
export type { AdapterCatalogEntry }
