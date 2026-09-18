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
  return (text.toLowerCase().match(WORD_RE) ?? []).map((w) => w.trim()).filter((w) => w.length > 0)
}

/** Checks whether `text` contains `term` as a whole word (case-insensitive). */
function containsWord(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  return new RegExp(`\\b${escaped}\\b`, "iu").test(text)
}

export interface ExtractLexiconOptions {
  /** Max number of terms to return. Default 20. */
  readonly top?: number
  /** Minimum term length (characters) to keep. Default 3. */
  readonly minLen?: number
}

/**
 * Pure helper: extract a corpus's signature lexicon — the most frequent
 * non-stopword terms across `corpusTexts` — for use as `eval.lexicon-hit-rate`
 * input. Offline / caller-side; this tool never calls it itself.
 */
export function extractLexicon(corpusTexts: readonly string[], opts?: ExtractLexiconOptions): string[] {
  const top = opts?.top ?? 20
  const minLen = opts?.minLen ?? 3
  const counts = new Map<string, number>()
  for (const text of corpusTexts) {
    for (const word of tokenize(text)) {
      if (word.length < minLen) continue
      if (FRENCH_STOPWORDS.has(word)) continue
      counts.set(word, (counts.get(word) ?? 0) + 1)
    }
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
    lexicon: z.array(z.string()).describe("Signature terms to look for, e.g. from extractLexicon."),
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
