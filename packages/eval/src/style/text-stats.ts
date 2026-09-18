import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { implementTool } from "@agentproto/driver"
import { scoreSchema } from "../score.js"

/**
 * `eval.text-stats` — deterministic French style metrics.
 *
 * Pure text statistics for the target's French output: bullet-line ratio,
 * first-person ratio, question rate, and mean sentence length (+ whether
 * that length falls inside a caller-supplied band). No LLM, no network —
 * every threshold is passed in as input so the caller (not this package)
 * owns the gate. See DESIGN.md §7 for the default production bands
 * (bullets ≤ 0.02, first-person ≥ 0.6).
 */

// ---------------------------------------------------------------------------
// pure metric helpers
// ---------------------------------------------------------------------------

const FIRST_PERSON_RE = /\b(je|j'|j’|moi|mon|ma|mes|me|m'|m’|nous|notre|nos|mien(?:ne)?s?)\b/iu

/**
 * Sentence-final abbreviations that must NOT be treated as a sentence
 * boundary — lowercased, without the trailing period. `p` + `ex` covers
 * "p. ex." (split across two chunks by the naive `.`-boundary split, then
 * re-merged token by token).
 */
const ABBREVIATIONS = new Set([
  "m", "mme", "mlle", "dr", "st", "ste", "etc", "cf", "vs", "p", "ex", "no", "art", "vol", "pp", "chap",
])

/** Split text into non-empty lines. */
function splitLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
}

/** True when `chunk` ends in an abbreviation (or a single capital initial) rather than a real sentence-final period. */
function endsWithAbbreviation(chunk: string): boolean {
  const match = chunk.match(/(\p{L}+)\.$/u)
  if (!match) return false
  const word = match[1]!
  if (ABBREVIATIONS.has(word.toLowerCase())) return true
  return word.length === 1 && /\p{Lu}/u.test(word)
}

/**
 * Split text into non-empty sentences on `.`/`!`/`?` boundaries, guarding
 * against abbreviations (`M.`, `Mme`, `Dr`, `etc.`, `cf.`, `p. ex.`) and
 * isolated capital initials (`J. Dupont`) so those periods don't count as
 * sentence ends.
 */
export function splitSentences(text: string): string[] {
  const chunks = text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const sentences: string[] = []
  for (const chunk of chunks) {
    const prevIndex = sentences.length - 1
    const prev = prevIndex >= 0 ? sentences[prevIndex] : undefined
    if (prev !== undefined && endsWithAbbreviation(prev)) {
      sentences[prevIndex] = `${prev} ${chunk}`
    } else {
      sentences.push(chunk)
    }
  }
  return sentences
}

/** Fraction of lines that open with a bullet marker (`-`, `*`, `•`, or `1.`) followed by whitespace — a marker glued to the next character (`1.5 million`, `-42 degrés`) is prose, not a bullet. */
export function bulletsRatio(text: string): number {
  const lines = splitLines(text)
  if (lines.length === 0) return 0
  const bulletLines = lines.filter((line) => /^([-*•]|\d+\.)\s+/u.test(line))
  return bulletLines.length / lines.length
}

/** Fraction of sentences carrying a French first-person marker. */
export function firstPersonRatio(text: string): number {
  const sentences = splitSentences(text)
  if (sentences.length === 0) return 0
  const firstPersonSentences = sentences.filter((s) => FIRST_PERSON_RE.test(s))
  return firstPersonSentences.length / sentences.length
}

/** Fraction of sentences ending in `?`. */
export function questionRate(text: string): number {
  const sentences = splitSentences(text)
  if (sentences.length === 0) return 0
  const questions = sentences.filter((s) => s.endsWith("?"))
  return questions.length / sentences.length
}

/** Mean number of words per sentence. */
export function meanSentenceLength(text: string): number {
  const sentences = splitSentences(text)
  if (sentences.length === 0) return 0
  const total = sentences.reduce((sum, s) => {
    const words = s.split(/\s+/u).filter((w) => w.length > 0)
    return sum + words.length
  }, 0)
  return total / sentences.length
}

export interface TextStats {
  readonly bulletsRatio: number
  readonly firstPersonRatio: number
  readonly questionRate: number
  readonly meanSentenceLength: number
  readonly inBand: boolean
}

export interface LengthBand {
  readonly min: number
  readonly max: number
}

const DEFAULT_LENGTH_BAND: LengthBand = { min: 5, max: 30 }

/** Compute every metric in one pass. */
export function computeTextStats(text: string, band: LengthBand = DEFAULT_LENGTH_BAND): TextStats {
  const length = meanSentenceLength(text)
  return {
    bulletsRatio: bulletsRatio(text),
    firstPersonRatio: firstPersonRatio(text),
    questionRate: questionRate(text),
    meanSentenceLength: length,
    inBand: length >= band.min && length <= band.max,
  }
}

// ---------------------------------------------------------------------------
// eval.text-stats — the TOOL contract
// ---------------------------------------------------------------------------

const textStatsThresholdsSchema = z.object({
  maxBulletsRatio: z.number().min(0).max(1).optional().describe("Default 0.02."),
  minFirstPersonRatio: z.number().min(0).max(1).optional().describe("Default 0.6."),
  lengthBand: z
    .object({ min: z.number().min(0), max: z.number().min(0) })
    .refine((band) => band.min <= band.max, { message: "lengthBand.min must be <= lengthBand.max" })
    .optional()
    .describe("Word-count band for mean sentence length. Default { min: 5, max: 30 }."),
})

export const textStatsTool = defineTool({
  id: "eval.text-stats",
  description:
    "Deterministic scorer: computes bullet-line ratio, first-person ratio, " +
    "question rate, and mean sentence length (+ inBand) over French text. " +
    "`passed` is derived from caller-supplied `thresholds` — this tool owns " +
    "no fixed gate.",
  version: "0.1.0",
  inputSchema: z.object({
    text: z.string().describe("The French text to analyze."),
    thresholds: textStatsThresholdsSchema.optional(),
  }),
  outputSchema: scoreSchema,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})

export const textStatsImpl = implementTool(textStatsTool, ({ input }) => {
  const thresholds = input.thresholds ?? {}
  const maxBulletsRatio = thresholds.maxBulletsRatio ?? 0.02
  const minFirstPersonRatio = thresholds.minFirstPersonRatio ?? 0.6
  const band = thresholds.lengthBand ?? DEFAULT_LENGTH_BAND

  const stats = computeTextStats(input.text, band)
  const bulletsOk = stats.bulletsRatio <= maxBulletsRatio
  const firstPersonOk = stats.firstPersonRatio >= minFirstPersonRatio
  const checks = [bulletsOk, firstPersonOk, stats.inBand]
  const value = checks.filter(Boolean).length / checks.length
  const passed = checks.every(Boolean)

  return {
    value,
    passed,
    label: "text-stats",
    rationale:
      `bulletsRatio=${stats.bulletsRatio.toFixed(3)} (max ${maxBulletsRatio}), ` +
      `firstPersonRatio=${stats.firstPersonRatio.toFixed(3)} (min ${minFirstPersonRatio}), ` +
      `questionRate=${stats.questionRate.toFixed(3)}, ` +
      `meanSentenceLength=${stats.meanSentenceLength.toFixed(1)}, ` +
      `inBand=${stats.inBand} (band ${band.min}-${band.max})`,
  }
})
