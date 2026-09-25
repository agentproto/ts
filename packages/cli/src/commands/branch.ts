/**
 * `agentproto branch <subcommand>`
 *
 * Subcommands:
 *   gc            [--repo <dir>] [--base <ref>] [--scopes local,remote,orphan]
 *                 [--min-age-days N] [--include-reviewed] [--anchor <sha>]
 *                 [--apply] [--json]
 *   review-queue  [--repo <dir>] [--base <ref>] [--min-age-days N] [--all]
 *
 * Thin shell over `@agentproto/worktree`'s `planBranchGc` / `applyBranchGc` —
 * the sibling of `agentproto worktree gc`. All classification and safety
 * logic lives in the engine; this resolves the repo, wires the same forge
 * `worktree gc` uses (for open-PR protection) plus the verdict store, and
 * renders the result. Also home of the daemon's injected ports behind
 * `branch_gc` / `branch_gc_verdict`.
 */
import { parseArgs } from "node:util"
import { resolve } from "node:path"
import {
  BRANCH_GC_SCOPES,
  createForgeClient,
  repoLabel,
  planBranchGc,
  applyBranchGc,
  summarizeBranchGcPlan,
  branchReviewQueue,
  recordBranchVerdict,
  FileBranchVerdictStore,
  type BranchRefKind,
  type BranchGcPlan,
  type BranchGcPlanEntry,
  type BranchGcApplyOutcome,
  type BranchGcSummary,
} from "@agentproto/worktree"
import type { BranchGcRunner, BranchGcVerdictRecorder } from "@agentproto/runtime"
import { repoRootOf } from "./worktree.js"

const USAGE = `agentproto branch — classify and clean up a repo's branches

Usage:
  agentproto branch gc           [--repo <dir>] [--base <ref>] [--scopes local,remote,orphan]
                                 [--min-age-days N] [--include-reviewed] [--anchor <sha>]
                                 [--apply] [--json]
  agentproto branch review-queue [--repo <dir>] [--base <ref>] [--min-age-days N] [--all]
  agentproto branch --help

  gc            Classify every local branch, base-remote branch (refs/remotes/<remote>)
                and orphan tracking ref (refs/remotes/<ns>/* of a removed remote) against
                --base (default origin/main):
                  reclaim  work provably in base: merged (ancestor), squash-merged
                           (merge-tree == base tree), patch-merged (git cherry, only on
                           conflicts), content-merged (every changed file's blob is in
                           base at some path, or gitignored)
                  review   unmerged, older than --min-age-days (default 3), unprotected
                  hold     base/protected names, branches checked out in a worktree and
                           their remote twin, open PR heads, everything local/remote when
                           the open-PR check is unavailable, young unmerged refs
                DRY RUN by default. --apply deletes reclaim entries of the kinds named by
                --scopes (required with --apply), re-classifying each one right before it
                is deleted, and writes a restore log (sha + re-create command per ref)
                under ~/.agentproto/branch-gc/. review and hold are never touched.
                --include-reviewed also reclaims review refs whose stored verdict
                (branch_gc_verdict) agreed for the same tip sha.
  review-queue  Print the review candidates as JSON — one per unique tip, with base sha,
                compare base, merge base, merged tree (or null), coverage and the files not
                provably in base. Tips that already have a verdict are skipped unless --all.
`

export async function runBranch(args: readonly string[]): Promise<number> {
  const sub = args[0]
  if (!sub || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  if (sub === "gc") return runBranchGcCommand(args.slice(1))
  if (sub === "review-queue") return runReviewQueue(args.slice(1))
  process.stderr.write(`agentproto branch: unknown subcommand "${sub}"\n  Known: gc | review-queue\n`)
  return 2
}

/** Parse `--scopes local,remote` into validated kinds; throws on an unknown kind. */
export function parseScopes(raw: string | undefined): BranchRefKind[] | undefined {
  if (!raw) return undefined
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean)
  for (const p of parts) {
    if (!(BRANCH_GC_SCOPES as readonly string[]).includes(p)) {
      throw new Error(`unknown scope "${p}" (expected ${BRANCH_GC_SCOPES.join(", ")})`)
    }
  }
  return parts as BranchRefKind[]
}

function parseMinAge(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) throw new Error(`--min-age-days must be a non-negative number, got "${raw}"`)
  return n
}

async function planFor(repoRoot: string, opts: {
  base?: string
  scopes?: BranchRefKind[]
  minAgeDays?: number
  includeReviewed?: boolean
  anchor?: string
}): Promise<BranchGcPlan> {
  const forge = await createForgeClient(repoRoot)
  return planBranchGc({
    repoRoot,
    repoName: repoLabel(repoRoot),
    forge,
    verdicts: new FileBranchVerdictStore(),
    ...(opts.base ? { base: opts.base } : {}),
    ...(opts.scopes ? { scopes: opts.scopes } : {}),
    ...(opts.minAgeDays !== undefined ? { minAgeDays: opts.minAgeDays } : {}),
    ...(opts.includeReviewed ? { includeReviewed: true } : {}),
    ...(opts.anchor ? { anchor: opts.anchor } : {}),
  })
}

async function runBranchGcCommand(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      scopes: { type: "string" },
      "min-age-days": { type: "string" },
      "include-reviewed": { type: "boolean" },
      anchor: { type: "string" },
      apply: { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  const repoRoot = repoRootOf(resolve(values.repo ?? process.cwd()))
  if (!repoRoot) {
    process.stderr.write("agentproto branch gc: not inside a git repository.\n")
    return 2
  }
  let scopes: BranchRefKind[] | undefined
  let minAgeDays: number | undefined
  try {
    scopes = parseScopes(values.scopes)
    minAgeDays = parseMinAge(values["min-age-days"])
  } catch (err) {
    process.stderr.write(`agentproto branch gc: ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
  if (values.apply && !scopes?.length) {
    process.stderr.write("agentproto branch gc: --apply requires --scopes (any of local,remote,orphan).\n")
    return 2
  }
  const plan = await planFor(repoRoot, {
    ...(values.base ? { base: values.base } : {}),
    ...(scopes ? { scopes } : {}),
    ...(minAgeDays !== undefined ? { minAgeDays } : {}),
    includeReviewed: Boolean(values["include-reviewed"]),
    ...(values.anchor ? { anchor: values.anchor } : {}),
  })
  const summary = summarizeBranchGcPlan(plan)
  if (!values.apply) {
    if (values.json) process.stdout.write(JSON.stringify({ plan, summary }, null, 2) + "\n")
    else printPlan(plan, summary)
    return 0
  }
  const { outcomes, restoreLog } = await applyBranchGc(plan, {
    scopes: scopes as BranchRefKind[],
    forge: await createForgeClient(repoRoot),
    verdicts: new FileBranchVerdictStore(),
  })
  if (values.json) process.stdout.write(JSON.stringify({ outcomes, restoreLog }, null, 2) + "\n")
  else printOutcomes(outcomes, restoreLog)
  return outcomes.some((o) => o.result === "failed") ? 1 : 0
}

async function runReviewQueue(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      "min-age-days": { type: "string" },
      all: { type: "boolean" },
    },
  })
  const repoRoot = repoRootOf(resolve(values.repo ?? process.cwd()))
  if (!repoRoot) {
    process.stderr.write("agentproto branch review-queue: not inside a git repository.\n")
    return 2
  }
  let minAgeDays: number | undefined
  try {
    minAgeDays = parseMinAge(values["min-age-days"])
  } catch (err) {
    process.stderr.write(`agentproto branch review-queue: ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
  const plan = await planFor(repoRoot, {
    ...(values.base ? { base: values.base } : {}),
    ...(minAgeDays !== undefined ? { minAgeDays } : {}),
  })
  process.stdout.write(JSON.stringify(branchReviewQueue(plan, { all: Boolean(values.all) }), null, 2) + "\n")
  return 0
}

function entryAction(e: BranchGcPlanEntry): string {
  if (e.class === "reclaim") return `reclaim (${e.reclaimReason})`
  if (e.class === "hold") return `hold (${e.holdReason}${e.holdDetail ? `: ${e.holdDetail}` : ""})`
  const c = e.coverage
  return `review${c ? ` (${c.unique}u ${c.evolved}e ${c.deletes}d)` : ""}${e.pushed ? ` ${e.pushed}` : ""}`
}

function printPlan(plan: BranchGcPlan, summary: BranchGcSummary): void {
  process.stdout.write(
    `base ${plan.base} @ ${plan.baseSha.slice(0, 10)}` +
      (plan.anchor ? `  anchor ${plan.anchor.slice(0, 10)}` : "") +
      `  PR check: ${plan.prCheck.available ? "ok" : `unavailable (${plan.prCheck.reason ?? "unknown"})`}\n\n`,
  )
  for (const e of plan.entries.filter((x) => x.class !== "reclaim").sort((a, b) => a.ageDays - b.ageDays)) {
    process.stdout.write(`${e.kind.padEnd(6)}  ${e.name.padEnd(48)}  ${String(e.ageDays).padStart(4)}d  ${entryAction(e)}\n`)
  }
  process.stdout.write("\n")
  for (const kind of plan.scopes) {
    const c = summary.byClass[kind]
    const statuses = Object.entries(summary.byStatus[kind]).map(([k, v]) => `${k}=${v}`).join("  ")
    process.stdout.write(`  ${kind.padEnd(6)}  reclaim=${c.reclaim}  review=${c.review}  hold=${c.hold}    [${statuses}]\n`)
  }
  if (plan.otherRemoteRefs) process.stdout.write(`  (${plan.otherRemoteRefs} ref(s) of other configured remotes left alone)\n`)
  process.stdout.write("\nDry run — pass --apply --scopes <kinds> to delete reclaim entries.\n")
}

function printOutcomes(outcomes: readonly BranchGcApplyOutcome[], restoreLog: string | null): void {
  for (const o of outcomes) {
    if (o.result === "held" || o.result === "skipped-review") continue
    let detail: string = o.result
    if (o.result === "deleted") detail = `deleted (${o.reclaimReason})`
    else if (o.result === "aborted-moved") detail = `aborted: tip moved to ${o.currentSha.slice(0, 10)} since the plan`
    else if (o.result === "aborted-reclassified") detail = `aborted: reclassified ${o.from} → ${o.to}${o.holdReason ? ` (${o.holdReason})` : ""}`
    else if (o.result === "failed") detail = `failed: ${o.message}`
    process.stdout.write(`${o.kind.padEnd(6)}  ${o.name.padEnd(48)}  ${detail}\n`)
  }
  const deleted = outcomes.filter((o) => o.result === "deleted").length
  const failed = outcomes.filter((o) => o.result === "failed").length
  process.stdout.write(`\n${deleted} deleted, ${failed} failed.${restoreLog ? ` Restore log: ${restoreLog}` : ""}\n`)
}

/**
 * Concrete `BranchGcRunner` for the daemon — the injected port behind
 * `branch_gc` and `POST /branches/gc`. Same construction as `agentproto
 * branch gc`: always plans; applies only when `apply` is set (the tool/route
 * boundary already enforces dry-run-by-default and scopes-on-apply).
 */
export function makeBranchGcRunner(): BranchGcRunner {
  return async ({ repoRoot: candidate, apply, base, scopes, minAgeDays, includeReviewed, anchor }) => {
    const repoRoot = repoRootOf(resolve(candidate))
    if (!repoRoot) throw new Error(`branch_gc: "${candidate}" is not inside a git repository.`)
    const plan = await planFor(repoRoot, {
      ...(base ? { base } : {}),
      ...(scopes ? { scopes } : {}),
      ...(minAgeDays !== undefined ? { minAgeDays } : {}),
      includeReviewed,
      ...(anchor ? { anchor } : {}),
    })
    const summary = summarizeBranchGcPlan(plan)
    if (!apply) return { mode: "plan", plan, summary }
    if (!scopes?.length) throw new Error("branch_gc: apply requires explicit scopes")
    const { outcomes, restoreLog } = await applyBranchGc(plan, {
      scopes,
      forge: await createForgeClient(repoRoot),
      verdicts: new FileBranchVerdictStore(),
    })
    return { mode: "apply", plan, summary, outcomes, restoreLog }
  }
}

/** Concrete `BranchGcVerdictRecorder` — the injected port behind `branch_gc_verdict`. */
export function makeBranchGcVerdictRecorder(): BranchGcVerdictRecorder {
  return async ({ repoRoot: candidate, verdict }) => {
    const repoRoot = repoRootOf(resolve(candidate))
    if (!repoRoot) throw new Error(`branch_gc_verdict: "${candidate}" is not inside a git repository.`)
    return recordBranchVerdict({ repoRoot, repoName: repoLabel(repoRoot), verdict, store: new FileBranchVerdictStore() })
  }
}
