/**
 * `corpus report <subcommand>` — build a long-form report from a dataset.
 *
 * The dataset (sources/ + entries/) is mounted READ-ONLY (ReadOnlyFs); the
 * report root is the only writer. Two FsPort instances, constructed here in
 * the adapter layer — the engine (`@agentproto/corpus/report`) stays pure.
 *
 *   corpus report packs [dataset] --config <f> [--out <dir>] [--views-dir <n>]
 *       Materialize per-chapter views + the global citation bibliography.
 *       --out defaults to the dataset (legacy fused layout); --views-dir
 *       defaults to "views" (pass "packs" to reproduce legacy on-disk output).
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { ReadOnlyFs } from "@agentproto/corpus"
import {
  buildPacks,
  stitchReport,
  reportConfigSchema,
} from "@agentproto/corpus/report"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"

export async function runReport(args: readonly string[]): Promise<ExitCode> {
  const [sub, ...rest] = args
  switch (sub) {
    case "packs":
      return await runReportPacks(rest)
    case "stitch":
      return await runReportStitch(rest)
    case undefined:
      return fail("report needs a subcommand (packs | stitch). Try --help.", 2)
    default:
      return fail(`unknown report subcommand "${sub}". Try --help.`, 2)
  }
}

/** Load + zod-validate a report config from a path (cwd-relative). */
function loadReportConfig(configPath: string) {
  const raw = readFileSync(path.resolve(process.cwd(), configPath), "utf8")
  return reportConfigSchema.parse(JSON.parse(raw))
}

async function runReportPacks(args: readonly string[]): Promise<ExitCode> {
  let dataset: string | undefined
  let configPath: string | undefined
  let out: string | undefined
  let viewsDir: string | undefined

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const next = () => args[++i]
    switch (a) {
      case "--config":
        configPath = next()
        break
      case "--out":
        out = next()
        break
      case "--views-dir":
        viewsDir = next()
        break
      default:
        if (!a.startsWith("-") && dataset === undefined) dataset = a
    }
  }

  const datasetPath = resolveWorkspacePath(dataset)
  if (!configPath) {
    return fail("report packs needs --config <report.config.json>.", 2)
  }

  let config
  try {
    config = loadReportConfig(configPath)
  } catch (err) {
    return fail(
      `could not load/validate config "${configPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
      2
    )
  }

  const reportRoot = out ? path.resolve(process.cwd(), out) : datasetPath
  const datasetFs = new ReadOnlyFs(new NodeFsAdapter({ root: datasetPath }))
  const reportFs = new NodeFsAdapter({ root: reportRoot })

  const result = await buildPacks({
    dataset: datasetFs,
    config,
    ...(viewsDir ? { viewsDir } : {}),
  })
  for (const file of result.files) {
    await reportFs.writeFile(file.path, file.content)
  }

  process.stdout.write(
    `report packs → ${result.files.length} files · ${result.bibliography} sources\n` +
      result.chapters.map((c) => `  ${c.id}: ${c.entryCount}`).join("\n") +
      "\n"
  )
  return 0
}

async function runReportStitch(args: readonly string[]): Promise<ExitCode> {
  let reportRoot: string | undefined
  let configPath: string | undefined
  let out: string | undefined
  let chaptersDir: string | undefined
  let viewsDir: string | undefined

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const next = () => args[++i]
    switch (a) {
      case "--config":
        configPath = next()
        break
      case "--out":
        out = next()
        break
      case "--chapters-dir":
        chaptersDir = next()
        break
      case "--views-dir":
        viewsDir = next()
        break
      default:
        if (!a.startsWith("-") && reportRoot === undefined) reportRoot = a
    }
  }

  const root = resolveWorkspacePath(reportRoot)
  if (!configPath) {
    return fail("report stitch needs --config <report.config.json>.", 2)
  }

  let config
  try {
    config = loadReportConfig(configPath)
  } catch (err) {
    return fail(
      `could not load/validate config "${configPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
      2
    )
  }

  const reportFs = new NodeFsAdapter({ root })
  const { content, wordCount } = await stitchReport({
    config,
    report: reportFs,
    ...(chaptersDir ? { chaptersDir } : {}),
    ...(viewsDir ? { viewsDir } : {}),
  })
  await reportFs.writeFile(out ?? "REPORT.md", content)
  process.stdout.write(`report stitch → ${out ?? "REPORT.md"} · ${wordCount} words\n`)
  return 0
}
