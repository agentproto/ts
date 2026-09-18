/**
 * Style scorers — F3.
 *
 * Five `eval.style-*` / style-adjacent TOOL contracts (see DESIGN.md §7):
 * two deterministic (`eval.text-stats`, `eval.lexicon-hit-rate`, bundled
 * below into `styleScorersProvider` exactly like `evalScorersProvider`) and
 * three model-backed (`eval.style-pairwise`, `eval.style-embedding`,
 * `eval.outline-fidelity`), each built by a `make*Driver(judge/embed)`
 * factory that closes over an injected, vendor-neutral capability — no LLM
 * SDK, no network dependency in this package.
 */

import { defineDriver } from "@agentproto/driver"
import { textStatsTool, textStatsImpl } from "./text-stats.js"
import { lexiconHitRateTool, lexiconHitRateImpl } from "./lexicon.js"

export {
  textStatsTool,
  textStatsImpl,
  bulletsRatio,
  firstPersonRatio,
  questionRate,
  meanSentenceLength,
  computeTextStats,
  type TextStats,
  type LengthBand,
} from "./text-stats.js"

export {
  lexiconHitRateTool,
  lexiconHitRateImpl,
  extractLexicon,
  type ExtractLexiconOptions,
} from "./lexicon.js"

export {
  stylePairwiseTool,
  makeStylePairwiseDriver,
  pairwiseWinRate,
  type StylePairwiseInput,
  type PairwiseWinner,
  type PairwiseVerdict,
  type PairwiseWinRateResult,
} from "./pairwise.js"

export {
  styleEmbeddingTool,
  makeStyleEmbeddingDriver,
  cosineToCentroid,
  type StyleEmbeddingInput,
  type EmbedFn,
  type MakeStyleEmbeddingDriverOptions,
} from "./style-embedding.js"

export {
  outlineFidelityTool,
  makeOutlineFidelityDriver,
  type OutlineFidelityInput,
} from "./outline-fidelity.js"

/**
 * Builtin AIP-30 PROVIDER bundling the two deterministic style scorers —
 * the pair DESIGN.md §7 names as the only style scorers safe to sample in
 * prod (free, zero network). The three model-backed style tools have no
 * static provider: each needs an injected judge/embed via its
 * `make*Driver(...)` factory, same pattern as `eval.llm-judge`.
 */
export const styleScorersProvider = defineDriver({
  id: "eval-style-scorers",
  name: "Eval Style Scorers (built-in)",
  description:
    "In-process deterministic style scorers: text-stats and " +
    "lexicon-hit-rate. Each is an AIP-14 TOOL whose output is the shared " +
    "Score shape.",
  version: "0.1.0",
  kind: "builtin",
  implements: [
    { tool: "eval.text-stats", version: "0.1.0" },
    { tool: "eval.lexicon-hit-rate", version: "0.1.0" },
  ],
  implementations: [textStatsImpl, lexiconHitRateImpl],
})
