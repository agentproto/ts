import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { implementTool } from "@agentproto/driver"
import { scoreSchema } from "../score.js"

/**
 * `eval.lexicon-hit-rate` — deterministic scorer: fraction of a caller-supplied
 * lexicon (a corpus's signature vocabulary) present in `text`. The lexicon
 * itself is an input, not baked into this package — `extractLexicon` below is
 * an offline helper to build one from a corpus, not something the tool calls.
 */

const WORD_RE = /\p{L}[\p{L}'’-]*/gu

/** A minimal French stopword set — filtered out so a "signature" lexicon is distinctive, not just frequent function words. */
const FRENCH_STOPWORDS = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "à", "au", "aux",
  "ce", "ces", "cet", "cette", "que", "qui", "quoi", "dont", "où",
  "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles",
  "est", "sont", "été", "être", "avoir", "ai", "as", "a", "avons", "avez", "ont",
  "pour", "par", "sur", "sous", "dans", "avec", "sans", "ne", "pas", "plus",
  "mais", "ou", "si", "se", "sa", "son", "ses", "leur", "leurs", "en", "y",
])

function tokenize(text: string): string[] {
  return (text.normalize("NFC").toLowerCase().match(WORD_RE) ?? []).map((w) => w.trim()).filter((w) => w.length > 0)
}

/**
 * Checks whether `text` contains `term` as a whole word (case-insensitive,
 * Unicode-aware). Uses lookaround boundaries instead of `\b`: `\b` is an
 * ASCII word-boundary even under the `u` flag, so it never matches around an
 * accented letter (`/\bécrire\b/iu.test("il aime écrire")` is `false`) —
 * lookarounds against `\p{L}\p{N}_` are boundary-correct for accented terms.
 */
function containsWord(text: string, term: string): boolean {
  const escaped = term.normalize("NFC").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu")
  return re.test(text.normalize("NFC"))
}

export interface ExtractLexiconOptions {
  /** Max number of terms to return. Default 20. */
  readonly top?: number
  /** Minimum term length (characters) to keep. Default 3. */
  readonly minLen?: number
  /**
   * Optional background corpus. When provided, terms are ranked by an
   * add-one-smoothed log-odds ratio of their rate in `corpusTexts` versus
   * their rate in `background`, surfacing terms disproportionately frequent
   * in the foreground corpus rather than merely frequent overall. This is a
   * simple frequency-ratio estimator, NOT the full variance-weighted
   * informative-Dirichlet log-odds estimator (Monroe et al. 2008) — it has
   * no correction for small counts beyond add-one smoothing, so rare terms
   * in a small background corpus can score unstably high. When omitted,
   * ranking falls back to raw frequency in `corpusTexts`.
   */
  readonly background?: readonly string[]
}

function countTerms(texts: readonly string[], minLen: number): Map<string, number> {
  const counts = new Map<string, number>()
  for (const text of texts) {
    for (const word of tokenize(text)) {
      if (word.length < minLen) continue
      if (FRENCH_STOPWORDS.has(word)) continue
      counts.set(word, (counts.get(word) ?? 0) + 1)
    }
  }
  return counts
}

function totalCount(counts: ReadonlyMap<string, number>): number {
  let total = 0
  for (const c of counts.values()) total += c
  return total
}

/**
 * Pure helper: extract a corpus's signature lexicon — the most frequent
 * non-stopword terms across `corpusTexts` — for use as `eval.lexicon-hit-rate`
 * input. Offline / caller-side; this tool never calls it itself.
 */
export function extractLexicon(corpusTexts: readonly string[], opts?: ExtractLexiconOptions): string[] {
  const top = opts?.top ?? 20
  const minLen = opts?.minLen ?? 3
  const counts = countTerms(corpusTexts, minLen)

  if (opts?.background && opts.background.length > 0) {
    const bgCounts = countTerms(opts.background, minLen)
    const fgTotal = totalCount(counts)
    const bgTotal = totalCount(bgCounts)
    return [...counts.entries()]
      .map(([word, fg]): [string, number] => {
        const bg = bgCounts.get(word) ?? 0
        const score = Math.log((fg + 1) / (fgTotal - fg + 1)) - Math.log((bg + 1) / (bgTotal - bg + 1))
        return [word, score]
      })
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, top)
      .map(([word]) => word)
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([word]) => word)
}

// ---------------------------------------------------------------------------
// eval.lexicon-hit-rate — the TOOL contract
// ---------------------------------------------------------------------------

export const lexiconHitRateTool = defineTool({
  id: "eval.lexicon-hit-rate",
  description:
    "Deterministic scorer: fraction of `lexicon` terms present as whole " +
    "words in `text` (case-insensitive). `passed = hitRate >= threshold` " +
    "(threshold default 0.5).",
  version: "0.1.0",
  inputSchema: z.object({
    text: z.string().describe("The text to score."),
    lexicon: z.array(z.string()).min(1).describe("Signature terms to look for, e.g. from extractLexicon."),
    threshold: z.number().min(0).max(1).optional().describe("Minimum hit rate to pass. Default 0.5."),
  }),
  outputSchema: scoreSchema,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})

export const lexiconHitRateImpl = implementTool(lexiconHitRateTool, ({ input }) => {
  const threshold = input.threshold ?? 0.5
  const lexicon = input.lexicon
  const hits = lexicon.filter((term) => containsWord(input.text, term))
  const hitRate = lexicon.length === 0 ? 0 : hits.length / lexicon.length
  const passed = hitRate >= threshold
  return {
    value: hitRate,
    passed,
    label: "lexicon-hit-rate",
    rationale: `${hits.length}/${lexicon.length} lexicon terms found (threshold ${threshold}): ${hits.join(", ") || "none"}`,
  }
})
