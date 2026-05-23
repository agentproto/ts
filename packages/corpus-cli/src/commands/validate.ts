/**
 * `corpus validate [path]` — JSON Schema check across every AIP file.
 */

import {
  CorpusValidator,
  CorpusWorkspaceReader,
} from "@agentproto/corpus"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { fail, loadAipSchemaBundle, resolveWorkspacePath, type ExitCode } from "./_shared.js"

export async function runValidate(args: readonly string[]): Promise<ExitCode> {
  const target = resolveWorkspacePath(args[0])
  const fs = new NodeFsAdapter({ root: target })

  if (!(await fs.exists("KNOWLEDGE.md"))) {
    return fail(
      `validate: no KNOWLEDGE.md at ${target}. Run \`corpus init marketing\` to scaffold one.`,
      1
    )
  }

  const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
  const validator = new CorpusValidator({ bundle: loadAipSchemaBundle() })
  const result = validator.validateWorkspace(snapshot)

  const counts = countBucket(snapshot)
  process.stdout.write(
    `corpus: scanned ${counts.total} files (${counts.summary})\n`
  )

  if (result.issues.length === 0) {
    process.stdout.write("corpus: all files conform to AIP schemas ✓\n")
    return 0
  }

  const errors = result.issues.filter((i) => i.severity === "error")
  const warns = result.issues.filter((i) => i.severity === "warn")
  const infos = result.issues.filter((i) => i.severity === "info")

  for (const i of result.issues) {
    const tag = i.severity === "error" ? "ERROR" : i.severity === "warn" ? "WARN " : "INFO "
    process.stdout.write(`  ${tag}  ${i.path}${i.instancePath}: ${i.message}\n`)
  }
  process.stdout.write(
    `corpus: ${errors.length} error${errors.length === 1 ? "" : "s"}, ` +
      `${warns.length} warning${warns.length === 1 ? "" : "s"}, ` +
      `${infos.length} info\n`
  )
  return result.valid ? 0 : 1
}

function countBucket(s: {
  workspace: unknown
  sources: readonly unknown[]
  entries: readonly unknown[]
  collections: readonly unknown[]
  collectionItems: readonly unknown[]
  playbooks: readonly unknown[]
  operators: readonly unknown[]
  workflows: readonly unknown[]
  routines: readonly unknown[]
  unknown: readonly unknown[]
}): { total: number; summary: string } {
  const parts: string[] = []
  if (s.workspace) parts.push("1 workspace")
  if (s.sources.length) parts.push(`${s.sources.length} sources`)
  if (s.entries.length) parts.push(`${s.entries.length} entries`)
  if (s.collections.length) parts.push(`${s.collections.length} collections`)
  if (s.collectionItems.length)
    parts.push(`${s.collectionItems.length} items`)
  if (s.playbooks.length) parts.push(`${s.playbooks.length} playbooks`)
  if (s.operators.length) parts.push(`${s.operators.length} operators`)
  if (s.workflows.length) parts.push(`${s.workflows.length} workflows`)
  if (s.routines.length) parts.push(`${s.routines.length} routines`)
  if (s.unknown.length) parts.push(`${s.unknown.length} unknown`)
  const total =
    (s.workspace ? 1 : 0) +
    s.sources.length +
    s.entries.length +
    s.collections.length +
    s.collectionItems.length +
    s.playbooks.length +
    s.operators.length +
    s.workflows.length +
    s.routines.length +
    s.unknown.length
  return { total, summary: parts.join(", ") }
}
