---
"@agentproto/eval": minor
---

Harden the style scorers: Unicode-safe lexicon matching (lookaround boundaries instead of ASCII `\b`, NFC normalization) and an optional `background` corpus option on `extractLexicon` ranked by an add-one-smoothed log-odds ratio; item-keyed inter-judge Cohen's kappa in `pairwiseWinRate` (new required `item` field on `PairwiseVerdict`, `kappa` widened to `number | null`, new `nNormal`/`nSwapped`/`balanced` result fields, order-group-averaged win rate); `cosineToCentroid` clamped to `[0, 1]` via `max(0, cosine)` (orthogonal candidates score 0, not 0.5) with a new `EmbeddingDimensionError` caught at the driver boundary; malformed judge verdicts now fail the score via a new exported `parseVerdict` helper; French text-stats gains `me`/`m'`/`nous`/`notre`/`nos`/`mien(ne)(s)` first-person markers, whitespace-required bullet markers, and abbreviation-guarded sentence splitting via a new exported `splitSentences` helper.
