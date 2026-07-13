/**
 * `corpus verify <workspace>` — ⑤b VERIFY pass for a corpus workspace
 * (deep-research SOP). Ports the semantics of the reference python script
 * (agentik-studio/.claude/skills/deep-research/verify-entries.py) as a
 * product command.
 *
 * Two checks, one command:
 *   1. Coverage — active entries per facet tag (thin facets need another
 *      discovery round).
 *   2. Self-flag scan — entries whose own text flags a bad scrape (wall-hit,
 *      wrong page, off-topic). Distill is honest but does NOT quarantine:
 *      these ship at high confidence unless moved out. --apply moves them
 *      (plus, with --contaminated, every sibling entry sharing a poisoned
 *      source) to demoted/ — a sibling of entries/, invisible to readers,
 *      fully reversible (files are moved, not deleted).
 */

import { mkdir, rename } from "node:fs/promises"
import path from "node:path"
import { CorpusWorkspaceReader, type ParsedFile } from "@agentproto/corpus"
import { NodeFsAdapter } from "../ports/local-fs.adapter.js"
import { fail, resolveWorkspacePath, type ExitCode } from "./_shared.js"

const FLAG_PATTERNS = [
  /does not match/i,
  /content is about/i,
  /no substantive content/i,
  /content mismatch/i,
  /appears to be a (?:newsletter|navigation|login|error) page/i,
  /stated title/i,
  /placeholder page/i,
  /cookie consent/i,
  /page could not be/i,
]

interface ParsedArgs {
  workspace: string | undefined
  facets: string[]
  thin: number
  apply: boolean
  contaminated: boolean
}

function parse(args: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    workspace: undefined,
    facets: [],
    thin: 8,
    apply: false,
    contaminated: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const next = () => args[++i]
    switch (a) {
      case "--facets": {
        const v = next()
        if (v) out.facets = v.split(",").map((s) => s.trim()).filter(Boolean)
        break
      }
      case "--thin": {
        const v = next()
        if (v) out.thin = Number(v)
        break
      }
      case "--apply":
        out.apply = true
        break
      case "--contaminated":
        out.contaminated = true
        break
      default:
        if (!a.startsWith("-") && out.workspace === undefined) out.workspace = a
    }
  }
  return out
}

/** First matching self-flag marker in `haystack`, or undefined. */
function firstFlag(haystack: string): string | undefined {
  for (const re of FLAG_PATTERNS) {
    const m = haystack.match(re)
    if (m) return m[0]
  }
  return undefined
}

/** `metadata.corpus.status`, defaulting to "active" — matches promote.ts. */
function entryStatus(entry: ParsedFile): string {
  const corpus = (entry.frontmatter.metadata as { corpus?: { status?: string } } | undefined)
    ?.corpus
  return corpus?.status ?? "active"
}

function tagsOf(entry: ParsedFile): readonly string[] {
  const tags = entry.frontmatter.tags
  return Array.isArray(tags) ? tags.map(String) : []
}

function sourcesOf(entry: ParsedFile): readonly string[] {
  const sources = entry.frontmatter.sources
  return Array.isArray(sources) ? sources.map(String) : []
}

export async function runVerify(args: readonly string[]): Promise<ExitCode> {
  const parsed = parse(args)
  if (parsed.facets.length === 0) {
    return fail(
      "verify requires --facets a,b,c. Usage: corpus verify <workspace> --facets landscape,daemons,... [--thin 8] [--apply] [--contaminated]",
      2
    )
  }

  const target = resolveWorkspacePath(parsed.workspace)
  const fs = new NodeFsAdapter({ root: target })

  if (!(await fs.exists("entries"))) {
    return fail(`verify: no entries/ under ${target}`, 1)
  }

  const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
  const entries = snapshot.entries.filter((e) => entryStatus(e) === "active")

  // ── Coverage ─────────────────────────────────────────────────────────
  const perFacet = new Map<string, number>()
  for (const facet of parsed.facets) perFacet.set(facet, 0)
  for (const entry of entries) {
    for (const tag of tagsOf(entry)) {
      if (perFacet.has(tag)) perFacet.set(tag, (perFacet.get(tag) ?? 0) + 1)
    }
  }

  process.stdout.write(`== coverage (${entries.length} entries) ==\n`)
  const thin: string[] = []
  for (const facet of parsed.facets) {
    const n = perFacet.get(facet) ?? 0
    if (n < parsed.thin) thin.push(facet)
    const mark = n < parsed.thin ? "  THIN ⚠" : ""
    process.stdout.write(`  ${facet.padEnd(16)} ${String(n).padStart(4)}${mark}\n`)
  }

  // ── Self-flag scan ───────────────────────────────────────────────────
  const flagged: Array<{ entry: ParsedFile; why: string }> = []
  for (const entry of entries) {
    const title = String(entry.frontmatter.title ?? "")
    const why = firstFlag(`${title}\n${entry.body}`)
    if (why) flagged.push({ entry, why })
  }

  process.stdout.write(`\n== self-flagged entries (${flagged.length}) ==\n`)
  const poisonedSources = new Set<string>()
  for (const { entry, why } of flagged) {
    process.stdout.write(`  ${entry.path}  [${why}]\n`)
    for (const s of sourcesOf(entry)) poisonedSources.add(s)
  }

  // ── Contaminated siblings ────────────────────────────────────────────
  const flaggedPaths = new Set(flagged.map((f) => f.entry.path))
  const contaminated: ParsedFile[] = []
  if (parsed.contaminated && poisonedSources.size > 0) {
    for (const entry of entries) {
      if (flaggedPaths.has(entry.path)) continue
      if (sourcesOf(entry).some((s) => poisonedSources.has(s))) {
        contaminated.push(entry)
      }
    }
    process.stdout.write(
      `\n== contaminated siblings (${contaminated.length}) from ${poisonedSources.size} poisoned source(s) ==\n`
    )
    for (const entry of contaminated) {
      process.stdout.write(`  ${entry.path}\n`)
    }
  }

  // ── Apply ────────────────────────────────────────────────────────────
  if (parsed.apply) {
    const toMove = [...flagged.map((f) => f.entry), ...contaminated]
    for (const entry of toMove) {
      const rel = path.relative("entries", entry.path)
      const dest = path.join(target, "demoted", rel)
      await mkdir(path.dirname(dest), { recursive: true })
      await rename(path.join(target, entry.path), dest)
    }
    process.stdout.write(`\nmoved ${toMove.length} entries → demoted/\n`)
  } else if (flagged.length > 0) {
    process.stdout.write(
      "\n(re-run with --apply to quarantine; --contaminated to also demote siblings)\n"
    )
  }

  if (thin.length > 0) {
    process.stdout.write(`\nthin facets → loop back to ② DISCOVER: ${thin.join(", ")}\n`)
  }

  return 0
}
