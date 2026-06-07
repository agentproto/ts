/**
 * `corpus knowledge [workspace] --tags a,b [--kind k] [--access scope] [--max n]`
 *
 * Previews what a skill's `knowledge:` binding resolves to — the refined
 * entries (with provenance) an operator would pull. Filesystem-first: scans
 * entries/ on disk, no graph engine.
 */

import {
  resolveKnowledge,
  isRefinedKind,
  type CorpusEntryQuery,
  type RefinedKind,
} from "@agentproto/corpus"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"

export async function runKnowledge(args: readonly string[]): Promise<ExitCode> {
  let workspace: string | undefined
  const tags: string[] = []
  const kinds: RefinedKind[] = []
  let access: string | undefined
  let max: number | undefined

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const next = () => args[++i]
    switch (a) {
      case "--tags": { const v = next(); if (v) tags.push(...v.split(",").map(s => s.trim()).filter(Boolean)); break }
      case "--kind": { const v = next(); if (v && isRefinedKind(v)) kinds.push(v); break }
      case "--access": access = next(); break
      case "--max": { const v = next(); if (v) max = Number(v); break }
      default: if (!a.startsWith("-") && workspace === undefined) workspace = a
    }
  }

  const target = resolveWorkspacePath(workspace)
  if (tags.length === 0 && kinds.length === 0) {
    return fail("knowledge needs --tags a,b and/or --kind <k>.", 2)
  }

  const query: CorpusEntryQuery = {
    ...(tags.length ? { tags } : {}),
    ...(kinds.length ? { kinds } : {}),
    ...(max !== undefined ? { maxResults: max } : {}),
  }
  const hits = await resolveKnowledge({
    fs: new NodeFsAdapter({ root: target }),
    query,
    ...(access ? { allowedAccess: new Set([access, "public"]) } : {}),
  })

  process.stdout.write(
    `knowledge ${tags.length ? `tags=[${tags.join(",")}] ` : ""}${kinds.length ? `kinds=[${kinds.join(",")}] ` : ""}→ ${hits.length} refined entries\n\n`
  )
  for (const h of hits) {
    process.stdout.write(
      `  • [${h.kind}] ${h.title}  (conf ${h.confidence})\n` +
        `    ↳ derivedFrom: ${h.sources.join(", ") || "—"}${h.access ? ` · access: ${h.access}` : ""}\n` +
        `    ${h.body.slice(0, 120).replace(/\s+/g, " ")}…\n\n`
    )
  }
  return 0
}
