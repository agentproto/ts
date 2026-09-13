/**
 * buildPacks — materialize a corpus dataset into per-chapter knowledge views
 * (the L2 "marts" of the pipeline) + a global citation bibliography.
 *
 * PURE: reads the dataset through an injected read-only `FsPort` and RETURNS
 * the files to write — it never writes. The frontend (CLI / AIP tool) owns
 * the report-rooted writer, so the dataset stays read-only to this module
 * (invariant 1). This is the single source of truth that both the Claude
 * `build-packs.mjs` and the AIP `corpus.report-packs` tool delegate to,
 * porting the skill's semantics (the authoritative reference).
 *
 * Global [n] citation numbering: every source in the dataset gets one stable
 * number (facet-ordered, then title); each distilled entry cites its sources
 * by those numbers. Chapter routing = facet match + keyword needles + cap.
 */

import matter from "gray-matter"
import type { FsPort } from "../ports/fs.port.js"
import type { ReportConfig } from "./types.js"
import { bibliographySha } from "./bib-sha.js"

export interface PackFile {
  /** Path relative to the report root (e.g. `views/_bibliography.json`). */
  readonly path: string
  readonly content: string
}

export interface BuildPacksResult {
  /** All files to write under the report root, in deterministic order. */
  readonly files: readonly PackFile[]
  /** Number of sources in the global bibliography. */
  readonly bibliography: number
  /**
   * Content-sha of the `[n]` → source-id mapping. Thread it into
   * `assembleChapters({ bibSha })` so stitch can detect chapters written
   * against a bibliography that has since been renumbered.
   */
  readonly bibliographySha: string
  /** Per-chapter view summary. */
  readonly chapters: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly entryCount: number
  }>
}

export interface BuildPacksOptions {
  /** Read-only view of the dataset (sources/ + entries/). */
  readonly dataset: FsPort
  readonly config: ReportConfig
  /**
   * Subdir under the report root for the views + bibliography. Default
   * `views`; the parity path against the legacy on-disk corpora passes
   * `packs`. Also embedded in each view's "Also read" pointer text.
   */
  readonly viewsDir?: string
}

interface SourceMeta {
  id: string
  title: string
  url: string
  tags: string[]
  n?: number
}

interface EntryMeta {
  kind: string
  title: string
  /** Raw confidence as authored (number or string) — string-compared on ties. */
  conf: number | string
  tags: string[]
  ns: number[]
  gist: string
}

/** flat(v) — join arrays with space, "" for null/undefined, else String(v). */
const flat = (v: unknown): string =>
  Array.isArray(v) ? v.join(" ") : v == null ? "" : String(v)

const asTags = (v: unknown): string[] =>
  Array.isArray(v) ? (v as string[]) : v ? [String(v)] : []

const firstSentence = (body: string): string => {
  const txt = body.replace(/^#.*$/gm, "").replace(/\s+/g, " ").trim()
  return (txt.split(/(?<=[.!?])\s/)[0] || txt).slice(0, 260)
}

/** Read every `.md` under `dir` in the FsPort's native walk order. */
async function walkMd(dataset: FsPort, dir: string): Promise<string[]> {
  let rels: readonly string[]
  try {
    rels = await dataset.walk(dir)
  } catch {
    return []
  }
  return rels.filter((r) => r.endsWith(".md")).map((r) => `${dir}/${r}`)
}

export async function buildPacks(
  opts: BuildPacksOptions
): Promise<BuildPacksResult> {
  const { dataset, config } = opts
  const viewsDir = opts.viewsDir ?? "views"
  const facetOrder = [...new Set(config.chapters.flatMap((c) => c.facets ?? []))]

  // ── sources → global bibliography ──────────────────────────────────────
  const sources: SourceMeta[] = []
  for (const path of await walkMd(dataset, "sources")) {
    let raw: string
    try {
      raw = await dataset.readFile(path)
    } catch {
      continue
    }
    let fm: Record<string, unknown> = {}
    try {
      fm = matter(raw).data as Record<string, unknown>
    } catch {
      fm = {}
    }
    const id = flat(fm.id).trim()
    if (!id) continue
    const corpusMeta =
      ((fm.metadata as Record<string, unknown> | undefined)?.corpus as
        | Record<string, unknown>
        | undefined) ?? {}
    const url = String(
      corpusMeta.originalUrl ?? corpusMeta.importerSourceUrl ?? ""
    )
      .replace(/\s+/g, "")
      .trim()
    sources.push({
      id,
      title: flat(fm.title).replace(/\s+/g, " ").trim(),
      url,
      tags: asTags(fm.tags),
    })
  }

  const facetOf = (s: SourceMeta): string =>
    facetOrder.find((f) => s.tags.includes(f)) ?? "other"
  sources.sort((a, b) => {
    const fa = facetOrder.indexOf(facetOf(a))
    const fb = facetOrder.indexOf(facetOf(b))
    if (fa !== fb) return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb)
    return a.title.localeCompare(b.title)
  })
  const idToN = new Map<string, number>()
  sources.forEach((s, i) => {
    s.n = i + 1
    idToN.set(s.id, i + 1)
  })

  // ── entries ────────────────────────────────────────────────────────────
  const entries: EntryMeta[] = []
  for (const path of await walkMd(dataset, "entries")) {
    let raw: string
    try {
      raw = await dataset.readFile(path)
    } catch {
      continue
    }
    let parsed: matter.GrayMatterFile<string>
    try {
      parsed = matter(raw)
    } catch {
      continue
    }
    const fm = parsed.data as Record<string, unknown>
    const title = flat(fm.title).replace(/\s+/g, " ").trim()
    if (!title) continue
    const segs = path.replace(/^entries\//, "").split("/")
    const kind =
      typeof fm.kind === "string" && fm.kind
        ? fm.kind
        : (segs.slice(-2)[0] ?? "unknown")
    const srcs = asTags(fm.sources).map((s) => flat(s).replace(/\s+/g, "").trim())
    const ns = [
      ...new Set(srcs.map((id) => idToN.get(id)).filter((n): n is number => !!n)),
    ].sort((a, b) => a - b)
    entries.push({
      kind,
      title,
      conf: (fm.confidence as number | string | undefined) ?? "",
      tags: asTags(fm.tags),
      ns,
      gist: firstSentence(parsed.content),
    })
  }

  // ── outputs ────────────────────────────────────────────────────────────
  const sha = bibliographySha(sources)
  const files: PackFile[] = []
  files.push({
    path: `${viewsDir}/_bibliography.json`,
    content: JSON.stringify({ sha, sources }, null, 2),
  })
  files.push({
    path: `${viewsDir}/_bibliography.md`,
    content:
      "# Bibliography (global citation index)\n\n" +
      sources.map((s) => `${s.n}. ${s.title || s.id} — ${s.url}`).join("\n") +
      "\n",
  })

  const chapters: Array<{ id: string; title: string; entryCount: number }> = []
  for (const ch of config.chapters) {
    const facets = ch.facets ?? []
    const kw = (ch.kw ?? []).map((s) => s.toLowerCase())
    const seen = new Set<string>()
    const scored: Array<{ e: EntryMeta; hits: number }> = []
    for (const e of entries) {
      if (!facets.some((f) => e.tags.includes(f))) continue
      const hay = `${e.title} ${e.tags.join(" ")} ${e.gist}`.toLowerCase()
      const hits = kw.filter((k) => hay.includes(k)).length
      if (kw.length && hits === 0) continue
      const key = e.title.toLowerCase().slice(0, 50)
      if (seen.has(key)) continue
      seen.add(key)
      scored.push({ e, hits })
    }
    scored.sort(
      (a, b) =>
        b.hits - a.hits ||
        String(b.e.conf).localeCompare(String(a.e.conf))
    )
    const picks = scored.slice(0, ch.cap ?? 28).map((x) => x.e)
    const srcFiles = [...new Set(facets.map((f) => `sources.${f}.md`))]
    const lines = picks.map(
      (e) =>
        `- **[${e.kind}]** ${e.title}${e.conf ? ` _(conf ${e.conf})_` : ""} ` +
        `${e.ns.length ? `[${e.ns.join(",")}]` : "[uncited]"}\n  ${e.gist}`
    )
    files.push({
      path: `${viewsDir}/${ch.id}.md`,
      content:
        `# Pack — ${ch.title}\n\n` +
        `**Facets:** ${facets.join(", ")} · **${picks.length} distilled claims** ` +
        `(each tagged with its global source number [n]).\n\n` +
        `**Also read for full context + exact quotes/URLs:** ${srcFiles.join(", ")} ` +
        `(in the corpus root), and ${viewsDir}/_bibliography.md.\n\n` +
        `## Distilled claims for this chapter\n\n${lines.join("\n")}\n`,
    })
    chapters.push({ id: ch.id, title: ch.title, entryCount: picks.length })
  }

  return { files, bibliography: sources.length, bibliographySha: sha, chapters }
}
