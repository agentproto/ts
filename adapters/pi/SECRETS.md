---
name: pi-secrets
id: pi-secrets
description: Secret slots pi reads at boot. At minimum ONE model-provider key MUST be present — pi routes each turn to whichever provider the selected model belongs to (Anthropic / OpenAI / Google).
version: 0.1.0
slots:
  - name: ANTHROPIC_API_KEY
    description: Anthropic API key — enables `anthropic/claude-*` models (adapter default provider).
    required: false
    sensitivity: high
  - name: OPENAI_API_KEY
    description: OpenAI API key — enables `openai/gpt-*` models.
    required: false
    sensitivity: high
  - name: GOOGLE_GENERATIVE_AI_API_KEY
    description: Google Generative AI (Gemini) key — enables `google/gemini-*` models.
    required: false
    sensitivity: high
constraints:
  - kind: at-least-one-of
    of:
      - ANTHROPIC_API_KEY
      - OPENAI_API_KEY
      - GOOGLE_GENERATIVE_AI_API_KEY
tags: [pi, secrets, model-providers]
---

# Pi — secrets inventory

Pi routes each turn to the provider that owns the selected model. The adapter
declares the three provider key slots pi's supported providers read from the
process environment:

| Env var | Provider | Unlocks |
| ------- | -------- | ------- |
| `ANTHROPIC_API_KEY` | Anthropic | `anthropic/claude-*` (adapter default) |
| `OPENAI_API_KEY` | OpenAI | `openai/gpt-*` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google | `google/gemini-*` |

**At least one** must be present, and it must match the provider of the model
you route to (`models.default` is `anthropic/claude-sonnet-4-5`, so
`ANTHROPIC_API_KEY` is the natural minimum). Keys are injected into the spawned
`pi --mode rpc` child's environment by the runner (from the workspace secrets
store) and are never logged.

Pi also accepts a per-invocation `--api-key`, but this adapter relies on the
env slots above so key material flows through the runner's secrets pipeline
rather than argv.
