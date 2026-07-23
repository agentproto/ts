/**
 * `corpus import-prs [workspace] --repo <owner/name>` — import a repo's pull
 * requests into the corpus workspace as AIP-10 sources + discovered candidates,
 * pulling each PR (description + review discussion + optional diff summary)
 * through the user's authenticated `gh` CLI.
 *
 *   corpus import-prs ./corpora/engineering \
 *     --repo agentproto/ts \
 *     --since 2026-06-01 --include-diff \
 *     --tags pr-review --lang en
 *
 * Pipeline: PrReviewImporter (PrSourcePort ← GhPrSourceAdapter) → ImporterRunner
 * writes `sources/pr-review/<batch>/<repo>-pr-<n>.md` + appends
 * `_candidates.yaml`. Each PR lands as `authority: secondary` — derived
 * commentary about the code, not the primary artifact. Distilling the sources
 * into `knowledge.entry/v1` (pattern/critique/summary) is the SEPARATE
 * `corpus distill` step — this command only stages the sources.
 *
 * The only external connection is the `gh` binary (reusing the user's existing
 * GitHub auth); everything else is local filesystem.
 */

import {
  ImporterRunner,
  PrReviewImporter,
  systemClock,
} from "@agentproto/corpus"
import { GhPrSourceAdapter } from "../ports/gh-pr-source.adapter.js"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { OsIdentityAdapter } from "../ports/os-identity.adapter.js"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"

interface ParsedArgs {
  workspace: string | undefined
  repo: string | undefined
  prNumbers: number[]
  since: string | undefined
  includeDiff: boolean
  tags: string[]
  lang: string | undefined
  max: number | undefined
  importerId: string
  dryRun: boolean
}

function parse(args: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    workspace: undefined,
    repo: undefined,
    prNumbers: [],
    since: undefined,
    includeDiff: false,
    tags: [],
    lang: undefined,
    max: undefined,
    importerId: "pr-review",
    dryRun: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const next = () => args[++i]
    switch (a) {
      case "--repo": out.repo = next(); break
      case "--pr": { const v = next(); if (v && Number.isFinite(Number(v))) out.prNumbers.push(Number(v)); break }
      case "--since": out.since = next(); break
      case "--include-diff": out.includeDiff = true; break
      case "--tags": { const v = next(); if (v) out.tags.push(...v.split(",").map(s => s.trim()).filter(Boolean)); break }
      case "--lang": out.lang = next(); break
      case "--max": { const v = next(); if (v) out.max = Number(v); break }
      case "--importer-id": out.importerId = next() ?? "pr-review"; break
      case "--dry-run": out.dryRun = true; break
      default:
        if (!a.startsWith("-") && out.workspace === undefined) out.workspace = a
    }
  }
  return out
}

export async function runImportPrs(args: readonly string[]): Promise<ExitCode> {
  const parsed = parse(args)
  const target = resolveWorkspacePath(parsed.workspace)

  if (!parsed.repo) {
    return fail('import-prs requires --repo <owner/name> (e.g. --repo agentproto/ts).', 2)
  }

  const selection =
    parsed.prNumbers.length > 0
      ? `PRs ${parsed.prNumbers.join(", ")}`
      : parsed.since
        ? `updated since ${parsed.since}`
        : "all PRs"
  const plan =
    `  workspace: ${target}\n` +
    `  repo:      ${parsed.repo}\n` +
    `  select:    ${selection}${parsed.max !== undefined ? ` (--max ${parsed.max})` : ""}\n` +
    `  diff:      ${parsed.includeDiff ? "included" : "omitted"}\n`

  // Dry run stays hermetic — it never shells out to `gh`, so it works offline
  // and in CI. It reports the plan (and any explicit PR numbers) only.
  if (parsed.dryRun) {
    process.stdout.write(`import-prs (dry run)\n${plan}`)
    for (const n of parsed.prNumbers.slice(0, 20)) {
      process.stdout.write(`    - ${parsed.repo}#${n}\n`)
    }
    if (parsed.prNumbers.length > 20) {
      process.stdout.write(`    … +${parsed.prNumbers.length - 20} more\n`)
    }
    return 0
  }
  process.stdout.write(`import-prs\n${plan}`)

  const importer = new PrReviewImporter({ source: new GhPrSourceAdapter() })

  const runner = new ImporterRunner({
    // The fs is rooted AT the workspace, so corpus paths are relative to it —
    // workspacePath is "" (root), NOT the absolute target.
    fs: new NodeFsAdapter({ root: target }),
    clock: systemClock,
    identity: new OsIdentityAdapter({ workspaceRoot: target }),
    workspacePath: "",
  })

  let report
  try {
    report = await runner.run(importer, {
      importerId: parsed.importerId,
      config: {
        repo: parsed.repo,
        ...(parsed.prNumbers.length > 0 ? { prNumbers: parsed.prNumbers } : {}),
        ...(parsed.since ? { since: parsed.since } : {}),
        ...(parsed.includeDiff ? { includeDiffSummary: true } : {}),
        ...(parsed.tags.length ? { tags: parsed.tags } : {}),
        ...(parsed.lang ? { language: parsed.lang } : {}),
        ...(parsed.max !== undefined ? { maxPRs: parsed.max } : {}),
      },
    })
  } catch (e) {
    return fail(`import failed: ${msg(e)}`, 1)
  }

  process.stdout.write(
    `import-prs → ${target}\n` +
      `  batch:      ${report.batchId}\n` +
      `  archived:   ${report.archivedSlugs.length}\n` +
      `  duplicates: ${report.duplicateSlugs.length}\n` +
      `  candidates: ${report.candidateIds.length}\n`
  )
  for (const w of report.warnings.slice(0, 20)) process.stdout.write(`  ! ${w}\n`)
  process.stdout.write(
    `\nNext: review candidates, then distill them — distillation turns the raw PR\n` +
      `sources into refined knowledge.entry/v1 (pattern/critique/summary).\n`
  )
  return 0
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
