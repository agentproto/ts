---
"@agentproto/eval": minor
---

Add style scorers: `eval.text-stats` and `eval.lexicon-hit-rate` (deterministic, bundled into a new `styleScorersProvider` builtin provider) plus model-backed `eval.style-pairwise`, `eval.style-embedding`, and `eval.outline-fidelity`, each built via an injected `make*Driver(judge/embed)` factory. Pure helpers `bulletsRatio`, `firstPersonRatio`, `questionRate`, `meanSentenceLength`, `computeTextStats`, `extractLexicon`, `pairwiseWinRate` (order-debiased win rate + Cohen's kappa), and `cosineToCentroid` are exported.
