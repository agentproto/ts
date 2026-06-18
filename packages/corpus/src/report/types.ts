/**
 * ReportConfig — the single source of truth for a long-form report rendered
 * from a corpus dataset. Superset of the two pre-existing shapes (the Claude
 * bible toolkit's `bible.config.json` + the AIP `bibleConfigSchema`); the
 * authoring reference is `.claude/skills/deep-research/bible/config.schema.md`.
 *
 * Validated with zod (NOT AJV — avoids corpus-cli's findSpecsRoot). Unknown
 * keys pass through so presentation/render fields the engine doesn't read
 * (covers, header/footer, parts) survive a parse round-trip untouched.
 */

import { z } from "zod"

/** A key/value fact rendered on a branded cover (`facts[]`). */
export const reportCoverFactSchema = z
  .object({ k: z.string(), v: z.string() })
  .passthrough()

/** One extra full-bleed cover (front or back). Data → one shared template. */
export const reportCoverPageSchema = z
  .object({
    kicker: z.string().optional(),
    title: z.string().optional(),
    meta: z.string().optional(),
    tag: z.string().optional(),
    align: z.string().optional(),
    facts: z.array(reportCoverFactSchema).optional(),
  })
  .passthrough()

/** The title cover (1re de couverture). */
export const reportCoverSchema = z
  .object({
    brand: z.string().optional(),
    subtitle: z.string().optional(),
    tag: z.string().optional(),
    meta: z.string().optional(),
    brandLetterSpacing: z.string().optional(),
    brandFontSize: z.string().optional(),
  })
  .passthrough()

/** A part grouping that drives stitch ordering. */
export const reportPartSchema = z
  .object({
    heading: z.string(),
    chapters: z.array(z.string()).default([]),
  })
  .passthrough()

/**
 * One report unit. Carries BOTH write fields (words/src/cover) and
 * pack-routing fields (facets/kw/cap). `id` doubles as the view filename
 * and the `<id>.md` chapter source.
 */
export const reportChapterSchema = z
  .object({
    /** = view filename + chapter source filename. */
    id: z.string(),
    /** Exact "## " heading the writer must use. */
    title: z.string(),
    /** Target length hint for the writer (e.g. "700–900"). */
    words: z.string().optional(),
    /** Analysis files (sources.<facet>.md) the writer/reviewer reads. */
    src: z.array(z.string()).optional(),
    /** The writer brief — what this chapter must cover. */
    cover: z.string().optional(),
    /** build-packs: which distilled-entry tags route into this view. */
    facets: z.array(z.string()).default([]),
    /** build-packs: keyword needles that rank (and gate) entries. */
    kw: z.array(z.string()).optional(),
    /** build-packs: max distilled claims in the view (default 28). */
    cap: z.number().optional(),
  })
  .passthrough()

export const reportConfigSchema = z
  .object({
    /** Dataset path (repo-relative). Legacy `bible.config.json` key. */
    workspace: z.string().optional(),
    /** Pointer to the dataset this report consumes (the portable form). */
    dataset: z.string().optional(),
    /** Multiple datasets feeding one report (1 report → M datasets). */
    corpora: z.array(z.string()).optional(),
    /** Render/prompt profile preset (bible | brief | memo | deck). */
    profile: z.string().optional(),
    /** Highest valid citation [n]; out-of-range = error (used downstream). */
    bibMax: z.number().optional(),

    title: z.string().optional(),
    cover: reportCoverSchema.optional(),
    frontCovers: z.array(reportCoverPageSchema).optional(),
    backCovers: z.array(reportCoverPageSchema).optional(),
    runningHeader: z.string().optional(),
    runningFooter: z.string().optional(),

    frontFile: z.string().optional(),
    annexesFile: z.string().optional(),
    parts: z.array(reportPartSchema).optional(),

    rulesText: z.string().optional(),
    factsText: z.string().optional(),
    briefText: z.string().optional(),

    chapters: z.array(reportChapterSchema),
  })
  .passthrough()

export type ReportCoverFact = z.infer<typeof reportCoverFactSchema>
export type ReportCoverPage = z.infer<typeof reportCoverPageSchema>
export type ReportCover = z.infer<typeof reportCoverSchema>
export type ReportPart = z.infer<typeof reportPartSchema>
export type ReportChapter = z.infer<typeof reportChapterSchema>
export type ReportConfig = z.infer<typeof reportConfigSchema>
