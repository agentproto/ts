/**
 * `corpus import-code [workspace]` — import a source tree into the corpus
 * workspace as AIP-10 sources (`knowledge.source/v1`) + discovered
 * candidates, one note per code unit.
 *
 *   corpus import-code ./corpora/engine \
 *     --root src \
 *     --include '**​/*.ts' --include '**​/*.tsx' \
 *     --granularity file \
 *     --tags engineering --lang en
 *
 * Pipeline: CodeImporter (FsPort ← NodeFsAdapter) → ImporterRunner writes
 * `sources/code/<batch>/<slug>.md` + appends `_candidates.yaml`.
 *
 * NOTES-ONLY SEAM: this command produces corpus notes only. It performs ZERO
 * code indexing and builds NO symbol / caller / callee graph — that is the
 * future code-brain subsystem's job. Everything here is local filesystem.
 */

import {
  CodeImporter,
  ImporterRunner,
  systemClock,
} from "@agentproto/corpus"
import type { ImporterTarget } from "@agentproto/corpus"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { OsIdentityAdapter } from "../ports/os-identity.adapter.js"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"

interface ParsedArgs {
  workspace: string | undefined
  root: string | undefined
  include: string[]
  granularity: "file" | "module"
  max: number | undefined
  tags: string[]
  lang: string | undefined
  importerId: string
  dryRun: boolean
}

function parse(args: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    workspace: undefined,
    root: undefined,
    include: [],
    granularity: "file",
    max: undefined,
    tags: [],
    lang: undefined,
    importerId: "code",
    dryRun: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const next = () => args[++i]
    switch (a) {
      case "--root": out.root = next(); break
      case "--include": { const v = next(); if (v) out.include.push(v); break }
      case "--granularity": {
        const v = next()
        if (v === "file" || v === "module") out.granularity = v
        break
      }
      case "--max": { const v = next(); if (v) out.max = Number(v); break }
      case "--tags": { const v = next(); if (v) out.tags.push(...v.split(",").map(s => s.trim()).filter(Boolean)); break }
      case "--lang": out.lang = next(); break
      case "--importer-id": out.importerId = next() ?? "code"; break
      case "--dry-run": out.dryRun = true; break
      default:
        if (!a.startsWith("-") && out.workspace === undefined) out.workspace = a
    }
  }
  return out
}

export async function runImportCode(args: readonly string[]): Promise<ExitCode> {
  const parsed = parse(args)
  const target = resolveWorkspacePath(parsed.workspace)

  if (!parsed.root) {
    return fail("import-code requires --root <path> (workspace-relative source tree).", 2)
  }

  const fs = new NodeFsAdapter({ root: target })
  const importer = new CodeImporter({ fs })
  const importerTarget: ImporterTarget = {
    importerId: parsed.importerId,
    config: {
      rootPath: parsed.root,
      ...(parsed.include.length ? { include: parsed.include } : {}),
      granularity: parsed.granularity,
      ...(parsed.max !== undefined ? { maxFiles: parsed.max } : {}),
      ...(parsed.tags.length ? { tags: parsed.tags } : {}),
      ...(parsed.lang ? { language: parsed.lang } : {}),
    },
  }

  const plan =
    `  workspace:   ${target}\n` +
    `  root:        ${parsed.root}\n` +
    `  include:     ${parsed.include.length ? parsed.include.join(", ") : "**/*.ts (default)"}\n` +
    `  granularity: ${parsed.granularity}\n` +
    (parsed.max !== undefined ? `  max:         ${parsed.max}\n` : "")

  // Dry run: enumerate the real importer (reads the tree, writes nothing) and
  // print what would be archived. Exercises the full enumerate path.
  if (parsed.dryRun) {
    process.stdout.write(`import-code (dry run)\n${plan}`)
    let count = 0
    try {
      for await (const source of importer.enumerate(importerTarget)) {
        if (count < 20) process.stdout.write(`    - ${source.slug}  (${source.title})\n`)
        count++
      }
    } catch (e) {
      return fail(`enumerate failed: ${msg(e)}`, 1)
    }
    if (count > 20) process.stdout.write(`    … +${count - 20} more\n`)
    process.stdout.write(`  units:       ${count}\n`)
    return 0
  }

  process.stdout.write(`import-code\n${plan}`)

  const runner = new ImporterRunner({
    // fs rooted AT the workspace → corpus paths are relative to it, so
    // workspacePath is "" (root), NOT the absolute target.
    fs,
    clock: systemClock,
    identity: new OsIdentityAdapter({ workspaceRoot: target }),
    workspacePath: "",
  })

  let report
  try {
    report = await runner.run(importer, importerTarget)
  } catch (e) {
    return fail(`import failed: ${msg(e)}`, 1)
  }

  process.stdout.write(
    `import-code → ${target}\n` +
      `  batch:      ${report.batchId}\n` +
      `  archived:   ${report.archivedSlugs.length}\n` +
      `  duplicates: ${report.duplicateSlugs.length}\n` +
      `  candidates: ${report.candidateIds.length}\n`
  )
  for (const w of report.warnings.slice(0, 20)) process.stdout.write(`  ! ${w}\n`)
  process.stdout.write(
    `\nNotes-only: this archives code notes as knowledge sources. Symbol/caller/callee\n` +
      `graph construction is the code-brain subsystem's job, not this importer.\n`
  )
  return 0
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
