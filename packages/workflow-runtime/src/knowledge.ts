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

import { resolveRef } from "./compile-workflow.js"
import type { Bindings } from "./types.js"
import type {
  HarnessKnowledgeSelector,
  KnowledgeAppliedRecord,
} from "./types.js"
import { NodeFsPort } from "./node-fs-port.js"

const DEFAULT_MAX_ENTRIES = 50

/**
 * Resolve one selector string against the run bindings (AIP-16 ref grammar).
 *
 * Rule: refs are only recognized at the START of the string. The leading
 * reference token — the longest match of `^\$(input|item|steps|index)((?:\.[^.$/]+)*)`
 * (so it stops at the first `/`, e.g. `$input.bookDir` in
 * `$input.bookDir/knowledge`) — is resolved against the bindings and
 * `String()`-ed; the remainder of the string is appended verbatim. A string
 * that is exactly a ref resolves to that value's string form. `$$` escapes to
 * a literal `$`. A string without a leading ref (including one with `$`
 * elsewhere) passes through untouched. An unresolvable or malformed ref
 * throws naming the step, the selector index, and the field.
 */
function resolveSelectorString(
  stepId: string,
  index: number,
  field: string,
  value: string,
  b: Bindings,
): string {
  if (value.startsWith("$$")) return value.slice(1)
  const m = value.match(/^\$(?:input|item|steps|index)((?:\.[^.$/]+)*)/)
  if (!m) return value
  const token = value.slice(0, m[0].length)
  let resolved: unknown
  try {
    resolved = resolveRef(token, b)
  } catch (err) {
    throw new Error(
      `step '${stepId}': harness.knowledge[${index}].${field} '${value}' is not a valid reference — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (resolved === undefined) {
    throw new Error(
      `step '${stepId}': harness.knowledge[${index}].${field} '${token}' resolves to nothing — the referenced field does not exist`,
    )
  }
  return String(resolved) + value.slice(m[0].length)
}

function resolveStringArray(
  stepId: string,
  index: number,
  field: string,
  values: readonly string[] | undefined,
  b: Bindings,
): string[] | undefined {
  if (values === undefined) return undefined
  return values.map((v) => resolveSelectorString(stepId, index, field, v, b))
}

/**
 * Resolve every `$…`-bearing string of each `harness.knowledge[]` selector
 * (`workspace`, `anyOf[]`, `allOf[]`, `kinds[]`) against the run bindings,
 * producing selectors whose strings are run-resolved and stripped of the
 * loader's internal `deferred` flag. Selectors without refs pass through
 * unchanged (a copy). See {@link resolveSelectorString} for the ref rule.
 */
export function resolveKnowledgeSelectors(
  stepId: string,
  selectors: readonly HarnessKnowledgeSelector[],
  b: Bindings,
): HarnessKnowledgeSelector[] {
  return selectors.map((sel, index) => {
    const deferred = sel.deferred === true
    const workspace = deferred
      ? resolveSelectorString(stepId, index, "workspace", sel.workspace, b)
      : sel.workspace
    return {
      ...sel,
      deferred: undefined,
      workspace,
      ...(sel.anyOf !== undefined
        ? { anyOf: deferred ? resolveStringArray(stepId, index, "anyOf", sel.anyOf, b) : [...sel.anyOf] }
        : {}),
      ...(sel.allOf !== undefined
        ? { allOf: deferred ? resolveStringArray(stepId, index, "allOf", sel.allOf, b) : [...sel.allOf] }
        : {}),
      ...(sel.kinds !== undefined
        ? { kinds: deferred ? resolveStringArray(stepId, index, "kinds", sel.kinds, b) : [...sel.kinds] }
        : {}),
    }
  })
}

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
      // A missing workspace after ref resolution is not a throw — the app's
      // gate decides (same seam as `knowledge-empty`); record the selector as
      // matching nothing and warn with the `knowledge-workspace-missing`
      // reason so hosts can distinguish it from an empty match.
      const warning = `knowledge-workspace-missing: harness.knowledge[${i}] (workspace '${workspace}') does not name an existing directory`
      warnings.push(warning)
      records.push({ workspace, matched: 0, written: 0 })
      continue
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
