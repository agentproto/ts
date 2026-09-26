# @agentproto/eval

## 0.3.1

### Patch Changes

- Updated dependencies [41b8b76]
- Updated dependencies [854db1f]
  - @agentproto/workflow-runtime@0.12.0

## 0.3.0

### Minor Changes

- c1a662e: Add style scorers: `eval.text-stats` and `eval.lexicon-hit-rate` (deterministic, bundled into a new `styleScorersProvider` builtin provider) plus model-backed `eval.style-pairwise`, `eval.style-embedding`, and `eval.outline-fidelity`, each built via an injected `make*Driver(judge/embed)` factory. Pure helpers `bulletsRatio`, `firstPersonRatio`, `questionRate`, `meanSentenceLength`, `computeTextStats`, `extractLexicon`, `pairwiseWinRate` (order-debiased win rate + Cohen's kappa), and `cosineToCentroid` are exported.
- 1ad2f1c: Harden the style scorers: Unicode-safe lexicon matching (lookaround boundaries instead of ASCII `\b`, NFC normalization) and an optional `background` corpus option on `extractLexicon` ranked by an add-one-smoothed log-odds ratio; item-keyed inter-judge Cohen's kappa in `pairwiseWinRate` (new required `item` field on `PairwiseVerdict`, `kappa` widened to `number | null`, new `nNormal`/`nSwapped`/`balanced` result fields, order-group-averaged win rate); `cosineToCentroid` clamped to `[0, 1]` via `max(0, cosine)` (orthogonal candidates score 0, not 0.5) with a new `EmbeddingDimensionError` caught at the driver boundary; malformed judge verdicts now fail the score via a new exported `parseVerdict` helper; French text-stats gains `me`/`m'`/`nous`/`notre`/`nos`/`mien(ne)(s)` first-person markers, whitespace-required bullet markers, and abbreviation-guarded sentence splitting via a new exported `splitSentences` helper.

## 0.2.11

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [c27f0b8]
  - @agentproto/driver@0.2.3
  - @agentproto/tool@0.3.1
  - @agentproto/workflow-runtime@0.11.1

## 0.2.10

### Patch Changes

- Updated dependencies [c809f12]
  - @agentproto/workflow-runtime@0.11.0

## 0.2.9

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
- Updated dependencies [20ef731]
  - @agentproto/driver@0.2.2
  - @agentproto/telemetry@0.2.3
  - @agentproto/tool@0.3.0
  - @agentproto/workflow-runtime@0.10.1

## 0.2.8

### Patch Changes

- Updated dependencies [c4bff00]
- Updated dependencies [f9e21fd]
- Updated dependencies [c4ebbd3]
- Updated dependencies [a48dc03]
- Updated dependencies [1cd0220]
- Updated dependencies [ece3cae]
- Updated dependencies [e7e9261]
- Updated dependencies [a04bd29]
- Updated dependencies [fe9a374]
  - @agentproto/workflow-runtime@0.10.0
  - @agentproto/driver@0.2.1
  - @agentproto/telemetry@0.2.2
  - @agentproto/tool@0.2.2

## 0.2.7

### Patch Changes

- Updated dependencies [11b5564]
  - @agentproto/workflow-runtime@0.9.0

## 0.2.6

### Patch Changes

- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

- Updated dependencies [f0c51a7]
  - @agentproto/driver@0.2.1
  - @agentproto/tool@0.2.2
  - @agentproto/workflow-runtime@0.8.1

## 0.2.5

### Patch Changes

- Updated dependencies [b1a8b7e]
  - @agentproto/workflow-runtime@0.8.0

## 0.2.4

### Patch Changes

- Updated dependencies [087f0ea]
- Updated dependencies [5e75a57]
- Updated dependencies [2962637]
  - @agentproto/workflow-runtime@0.7.0

## 0.2.3

### Patch Changes

- Updated dependencies [831d4f5]
- Updated dependencies [23fa73e]
- Updated dependencies [04aedad]
  - @agentproto/driver@0.2.0
  - @agentproto/workflow-runtime@0.6.0
  - @agentproto/telemetry@0.2.2

## 0.2.2

### Patch Changes

- Updated dependencies [57d1499]
  - @agentproto/workflow-runtime@0.5.0

## 0.2.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
- Updated dependencies [e0fbccc]
  - @agentproto/driver@0.1.3
  - @agentproto/telemetry@0.2.1
  - @agentproto/tool@0.2.1
  - @agentproto/workflow-runtime@0.4.0

## 0.2.0

### Minor Changes

- 559cd7d: Add @agentproto/telemetry port + OTel adapter and @agentproto/eval scorers + runEval
- fd03d7a: Add eval.llm-judge scorer with makeLlmJudgeDriver and llmJudge convenience factory

### Patch Changes

- Updated dependencies [f8ebe41]
- Updated dependencies [7aaf24a]
- Updated dependencies [559cd7d]
- Updated dependencies [2154ed5]
  - @agentproto/workflow-runtime@0.3.0
  - @agentproto/telemetry@0.2.0
