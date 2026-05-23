/**
 * `corpus lint [path]` — run lints declared in KNOWLEDGE.md.
 */

import {
  CorpusLinter,
  CorpusWorkspaceReader,
  systemClock,
} from "@agentproto/corpus"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"

export async function runLint(args: readonly string[]): Promise<ExitCode> {
  const target = resolveWorkspacePath(args[0])
  const fs = new NodeFsAdapter({ root: target })

  if (!(await fs.exists("KNOWLEDGE.md"))) {
    return fail(
      `lint: no KNOWLEDGE.md at ${target}. Run \`corpus init marketing\` to scaffold one.`,
      1
    )
  }

  const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
  const report = new CorpusLinter({ clock: systemClock }).lint(snapshot)

  if (report.issues.length === 0) {
    process.stdout.write("corpus: lint clean ✓\n")
    return 0
  }

  for (const i of report.issues) {
    const tag =
      i.severity === "error"
        ? "ERROR"
        : i.severity === "warn"
        ? "WARN "
        : "INFO "
    process.stdout.write(`  ${tag}  [${i.lintId}]  ${i.path}: ${i.message}\n`)
  }
  process.stdout.write(
    `corpus: ${report.errorCount} error${report.errorCount === 1 ? "" : "s"}, ` +
      `${report.warnCount} warning${report.warnCount === 1 ? "" : "s"}, ` +
      `${report.infoCount} info\n`
  )
  // Non-zero exit only on errors — warnings/infos don't fail CI by default.
  return report.errorCount > 0 ? 1 : 0
}
