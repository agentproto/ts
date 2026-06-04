/**
 * DistillRunner — turn one raw source into refined AIP-10 entries.
 *
 * Reads nothing itself beyond what it's handed; writes each distilled item
 * as `entries/<kind-plural>/<year>/<slug>.md` with `sources: [<sourceId>]`
 * (the provenance edge) and inherited `access`. Pure: consumes FsPort +
 * ClockPort + an injected DistillPort. The filesystem refs are the graph.
 */

import matter from "gray-matter"
import type { FsPort } from "../ports/fs.port.js"
import type { ClockPort } from "../ports/clock.port.js"
import type { DistillPort, DistilledItem, RefinedKind } from "./types.js"

const KIND_DIR: Record<RefinedKind, string> = {
  principle: "principles",
  pattern: "patterns",
  critique: "critiques",
  summary: "summaries",
  example: "examples",
}

export interface DistillSource {
  /** The raw source's AIP-10 id (becomes the `sources:` provenance ref). */
  readonly id: string
  readonly title: string
  readonly body: string
  readonly tags?: readonly string[]
  /** Access scope inherited by every entry distilled from this source. */
  readonly access?: string
  readonly domain?: string
}

export interface DistillRunReport {
  readonly sourceId: string
  readonly entryPaths: readonly string[]
  readonly skipped: readonly string[] // slugs skipped (already exist)
}

export interface DistillRunnerOptions {
  readonly fs: FsPort
  readonly clock: ClockPort
  readonly distiller: DistillPort
}

export class DistillRunner {
  constructor(private readonly opts: DistillRunnerOptions) {}

  async run(source: DistillSource): Promise<DistillRunReport> {
    const items = await this.opts.distiller.distill({
      title: source.title,
      body: source.body,
      ...(source.tags ? { tags: source.tags } : {}),
    })

    const year = this.opts.clock.now().getUTCFullYear()
    const seen = new Set<string>()
    const entryPaths: string[] = []
    const skipped: string[] = []

    for (const item of items) {
      if (!item.title.trim() || !item.body.trim()) continue
      const slug = uniqueSlug(makeSlug(item.title), seen)
      const dir = KIND_DIR[item.kind]
      const path = `entries/${dir}/${year}/${slug}.md`

      if (await this.opts.fs.exists(path)) {
        skipped.push(slug)
        continue
      }
      await this.opts.fs.writeFile(path, serializeEntry(item, slug, source, this.opts.clock))
      entryPaths.push(path)
    }
    return { sourceId: source.id, entryPaths, skipped }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function serializeEntry(
  item: DistilledItem,
  slug: string,
  source: DistillSource,
  clock: ClockPort
): string {
  const now = clock.now().toISOString()
  const fm: Record<string, unknown> = {
    schema: "knowledge.entry/v1",
    slug,
    kind: item.kind,
    title: item.title,
    updated_at: now,
    sources: [source.id], // ← derivedFrom / provenance edge
    confidence: typeof item.confidence === "number" ? item.confidence : 0.7,
    tags: dedupeTags(item.tags, source.tags),
    metadata: {
      corpus: {
        status: "active",
        ...(source.domain ? { domain: source.domain } : {}),
        // access inherited from the source — propagates up the chain so a
        // refined insight is never more visible than its evidence.
        ...(source.access ? { access: source.access } : {}),
        promotionMode: "auto-distill",
        promotedAt: now,
      },
    },
  }
  const body = item.body.trim()
  return matter.stringify(body.startsWith("\n") ? body : "\n" + body, fm)
}

function dedupeTags(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): string[] {
  const out = new Set<string>()
  for (const raw of [...(a ?? []), ...(b ?? [])]) {
    const t = sanitizeTag(raw)
    if (t) out.add(t)
  }
  return [...out]
}

/** AIP-10 tag pattern is ^[a-z][a-z0-9-]*$ — lowercase, strip accents,
 *  kebab-ize, drop anything that can't start with a letter. */
function sanitizeTag(raw: string): string | null {
  const t = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
  return /^[a-z][a-z0-9-]*$/.test(t) ? t : null
}

function makeSlug(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // strip combining diacritics
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 80) || "entry"
  )
}

function uniqueSlug(base: string, seen: Set<string>): string {
  let slug = base
  let n = 2
  while (seen.has(slug)) slug = `${base}-${n++}`.slice(0, 80)
  seen.add(slug)
  return slug
}
