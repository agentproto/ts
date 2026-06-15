/**
 * Bare corpus scaffold — the domain-agnostic starting point for `corpus init`.
 *
 * Emits ONLY the AIP-10 skeleton: a neutral `knowledge.workspace/v1` manifest +
 * the standard folder structure (kept by `.gitkeep`). No operators, playbooks,
 * workflows, routines, or seed entries — those are opt-in starters (`--with`) or
 * a full preset (`--preset`). This is what you want for a fresh research corpus:
 * structure without someone else's domain boilerplate.
 */

/** kebab/slug → Title Case for the manifest title. */
function titleCase(name: string): string {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase())
}

/** The six generic AIP-10 entry kinds (no domain-specific PlaybookCase). */
const ENTRY_KINDS = [
  "principles",
  "patterns",
  "critiques",
  "examples",
  "summaries",
  "timelines",
] as const

/** Neutral, schema-valid `knowledge.workspace/v1` manifest. */
function bareManifest(name: string): string {
  const title = titleCase(name)
  return `---
schema: knowledge.workspace/v1
name: ${name}
title: ${title}
description: >-
  ${title} knowledge corpus (AIP-10). Sources are scraped + content-hashed and
  immutable; entries are distilled, curated, mutable claims that cite them.
  This manifest is intentionally domain-agnostic — tune entityTypes, lints, and
  metadata.corpus to fit the domain.
version: 1.0.0
entityTypes:
  - { name: Principle, description: "Durable expert rule" }
  - { name: Example, description: "Concrete source-derived example" }
  - { name: Pattern, description: "Reusable transferable mechanic" }
  - { name: Critique, description: "Negative example or failure mode" }
  - { name: Summary, description: "Compressed source synthesis" }
  - { name: Timeline, description: "Time-sensitive evolution" }
sources:
  retention: forever
  signing: optional
  hashAlgo: sha256
  authorityDefault: secondary
lints:
  - { id: require-source-on-examples, kind: require-source, appliesTo: Example, severity: error }
  - { id: broken-ref-all, kind: broken-ref, appliesTo: "*", severity: error }
  - { id: orphan-all, kind: orphan, appliesTo: "*", severity: info }
curation:
  tone: "neutral, expert, source-backed"
  depth: medium
  autoLink: byName
  conflictResolution: authority
queryHints:
  preferRecent: true
  preferAuthoritative: true
metadata:
  corpus:
    # "flat" → entries/<kind>/<slug>.md (matches the scaffolded dirs).
    # Set "dated" for entries/<kind>/<year>/<slug>.md on high-volume corpora.
    entryLayout: flat
---

# ${title}

Neutral AIP-10 knowledge workspace.

- \`sources/\` — scraped source snapshots (immutable provenance: \`captured_at\` + \`content_hash\`)
- \`entries/<kind>/\` — distilled, curated claims that cite sources
- \`collections/\` — AIP-18 curation collections (candidates, etc.)

Populate with \`corpus import-web\` → \`corpus distill\` → \`corpus knowledge\`.
`
}

/** Opt-in starter surfaces (`--with`): the AIP integration dirs. */
export const STARTER_SURFACES: Record<string, { dir: string; aip: string }> = {
  operators: { dir: "operators", aip: "AIP-9 (OPERATOR.md per operator)" },
  playbooks: { dir: "playbooks", aip: "AIP-12 (PLAYBOOK.md per playbook)" },
  workflows: { dir: "workflows", aip: "AIP-15 (WORKFLOW.md per workflow)" },
  routines: { dir: "routines", aip: "AIP-41 (ROUTINE.md per routine)" },
}

/**
 * Build the bare workspace file set (path → content). Dirs are materialised via
 * `.gitkeep`. `withStarters` adds opt-in integration surfaces, each kept with a
 * `.gitkeep` + a README pointing at its AIP.
 */
export function buildBareWorkspace(
  name: string,
  withStarters: readonly string[] = []
): Record<string, string> {
  const files: Record<string, string> = {
    "KNOWLEDGE.md": bareManifest(name),
    "sources/.gitkeep": "",
    "collections/.gitkeep": "",
  }
  for (const kind of ENTRY_KINDS) files[`entries/${kind}/.gitkeep`] = ""

  for (const s of withStarters) {
    const surface = STARTER_SURFACES[s]
    if (!surface) continue
    files[`${surface.dir}/.gitkeep`] = ""
    files[`${surface.dir}/README.md`] =
      `# ${titleCase(s)}\n\n` +
      `Opt-in starter surface. Add one file per item: ${surface.aip}.\n`
  }
  return files
}
