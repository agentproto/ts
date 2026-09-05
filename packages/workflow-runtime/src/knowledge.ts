/**
 * `harness.knowledge` materialization (AIP-15 P2) — resolve each selector
 * against its AIP-10 corpus workspace with the same `resolveKnowledge` the
 * corpus CLI previews with, then write the matched raw entries (frontmatter +
 * body) into the step's cwd under `.knowledge/` BEFORE the step's session
 * runs. Idempotent: every run rewrites the same deterministic file set.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join } from "node:path"

import {
  filterEntriesByAllOf,
  isRefinedKind,
  resolveKnowledge,
  type RefinedKind,
} from "@agentproto/corpus"

import type {
  HarnessKnowledgeSelector,
  KnowledgeAppliedRecord,
} from "./types.js"
import { NodeFsPort } from "./node-fs-port.js"

const DEFAULT_MAX_ENTRIES = 50

/** `../corpus-writer` → `corpus-writer`; `.` → the dir's own basename. */
function workspaceDirName(workspace: string): string {
  const trimmed = workspace.replace(/\/+$/, "")
  return basename(trimmed) || trimmed
}

/** Entries are written as `<slug>.md` — flatten anything path-like. */
function safeSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9._-]+/g, "-")
}

export interface MaterializedKnowledge {
  records: KnowledgeAppliedRecord[]
  /** Total entries written across all selectors — drives the prompt note. */
  written: number
  /** human-readable warnings for empty matches (`knowledge-empty`). */
  warnings: string[]
}

/**
 * Materialize every selector in `selectors` under `<stepCwd>/.knowledge/`.
 * Throws on a non-"files" `mode` or an unreadable workspace — the loader
 * rejects both earlier; this is the direct-TS-authoring path's backstop.
 */
export async function materializeKnowledge(
  stepId: string,
  selectors: readonly HarnessKnowledgeSelector[],
  stepCwd: string,
): Promise<MaterializedKnowledge> {
  const knowledgeDir = join(stepCwd, ".knowledge")
  const records: KnowledgeAppliedRecord[] = []
  const warnings: string[] = []
  const indexSections: string[] = []
  let written = 0

  for (const [i, sel] of selectors.entries()) {
    if (sel.mode !== undefined && sel.mode !== "files") {
      throw new Error(
        `step '${stepId}': harness.knowledge[${i}].mode must be "files" (v1 supports no other mode)`,
      )
    }
    const workspace = sel.workspace
    if (typeof workspace !== "string" || workspace.length === 0) {
      throw new Error(
        `step '${stepId}': harness.knowledge[${i}] needs a non-empty 'workspace'`,
      )
    }
    if (!isAbsolute(workspace)) {
      throw new Error(
        `step '${stepId}': harness.knowledge[${i}].workspace '${workspace}' must be absolute by run time — the loader resolves relative paths; did you bypass loadWorkflowHandle?`,
      )
    }

    const fs = new NodeFsPort(workspace)
    const rootStat = await fs.stat(".")
    if (rootStat === null || rootStat.kind !== "directory") {
      throw new Error(
        `step '${stepId}': harness.knowledge[${i}].workspace '${workspace}' does not name an existing directory`,
      )
    }

    const kinds = (sel.kinds ?? []).filter((k): k is RefinedKind => isRefinedKind(k))
    const resolved = filterEntriesByAllOf(
      await resolveKnowledge({
        fs,
        query: {
          ...(sel.anyOf && sel.anyOf.length > 0 ? { tags: [...sel.anyOf] } : {}),
          ...(kinds.length > 0 ? { kinds } : {}),
        },
      }),
      sel.allOf,
    )

    // Deterministic order: slug ascending, then the cap.
    const sorted = [...resolved].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    const cap = sel.maxEntries ?? DEFAULT_MAX_ENTRIES
    const picked = sorted.slice(0, cap)

    const dirName = workspaceDirName(workspace)
    const lines: string[] = []
    for (const entry of picked) {
      const rel = join(dirName, `${safeSlug(entry.slug)}.md`)
      // Raw entry: frontmatter + body, exactly as it lives in the workspace.
      const raw = await fs.readFile(entry.path)
      await mkdir(join(knowledgeDir, dirName), { recursive: true })
      await writeFile(join(knowledgeDir, rel), raw, "utf8")
      lines.push(
        `- [${entry.title || entry.slug}](${rel.split("\\").join("/")}) — ${entry.kind}, ${entry.tags.join(", ")}`,
      )
    }
    written += picked.length
    if (lines.length > 0) {
      indexSections.push(`## ${dirName}\n\n${lines.join("\n")}`)
    }

    records.push({ workspace, matched: resolved.length, written: picked.length })
    if (resolved.length === 0) {
      warnings.push(
        `knowledge-empty: harness.knowledge[${i}] (workspace '${workspace}') matched 0 entries`,
      )
    }
  }

  // Deterministic INDEX.md — selectors in declaration order, entries by slug.
  const index =
    "# Knowledge index\n\n" +
    (indexSections.length > 0 ? indexSections.join("\n\n") : "_No entries matched._") +
    "\n"
  await mkdir(knowledgeDir, { recursive: true })
  await writeFile(join(knowledgeDir, "INDEX.md"), index, "utf8")

  return { records, written, warnings }
}
