---
name: pi-secrets
id: pi-secrets
description: Secret slots pi reads at boot. At minimum ONE model-provider key MUST be present — pi routes each turn to whichever provider the selected model belongs to (Anthropic / OpenAI / Google / Moonshot / OpenRouter / OpenCode Zen / OpenCode Go).
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
  - name: MOONSHOT_API_KEY
    description: Moonshot AI API key — enables `moonshotai/kimi-*` models.
    required: false
    sensitivity: high
  - name: OPENROUTER_API_KEY
    description: OpenRouter API key — enables `openrouter/<vendor>/<product>` models (verified live against `openrouter/deepseek/deepseek-v4.1-flash` and `openrouter/z-ai/glm-5.3-flash`).
    required: false
    sensitivity: high
  - name: OPENCODE_API_KEY
    description: OpenCode API key, enables `opencode/<id>` (Zen) and `opencode-go/<id>` (Go) models. Pi reads the same var for both providers; the access profile's endpoint decides which balance bills.
    required: false
    sensitivity: high
  - name: OPENCODE_CONSOLE_TOKEN
    description: OpenCode console bearer for a Go profile pinned to a console org (set by the opencode console sub-account resolution, never stored on the profile). The adapter references it from a per-session pi provider override together with the org's `x-opencode-org-id` header.
    required: false
    sensitivity: high
constraints:
  - kind: at-least-one-of
    of:
      - ANTHROPIC_API_KEY
      - OPENAI_API_KEY
      - GOOGLE_GENERATIVE_AI_API_KEY
      - MOONSHOT_API_KEY
      - OPENROUTER_API_KEY
      - OPENCODE_API_KEY
      - OPENCODE_CONSOLE_TOKEN
tags: [pi, secrets, model-providers]
---

# Pi — secrets inventory

Pi routes each turn to the provider that owns the selected model. The adapter
declares the provider key slots pi's supported providers read from the
process environment:

| Env var | Provider | Unlocks |
| ------- | -------- | ------- |
| `ANTHROPIC_API_KEY` | Anthropic | `anthropic/claude-*` (adapter default) |
| `OPENAI_API_KEY` | OpenAI | `openai/gpt-*` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google | `google/gemini-*` |
| `MOONSHOT_API_KEY` | Moonshot AI | `moonshotai/kimi-*` |
| `OPENROUTER_API_KEY` | OpenRouter | `openrouter/<vendor>/<product>` (e.g. `openrouter/deepseek/deepseek-v4.1-flash`) |
| `OPENCODE_API_KEY` | OpenCode Zen / OpenCode Go | `opencode/<id>`, `opencode-go/<id>` (same var for both; the profile's endpoint picks the balance) |
| `OPENCODE_CONSOLE_TOKEN` | OpenCode Go console org | `opencode-go/<id>` billed to a pinned console org: referenced as `${OPENCODE_CONSOLE_TOKEN}` from the per-session pi provider override, next to the org's `x-opencode-org-id` header |

**At least one** must be present, and it must match the provider of the model
you route to (`models.default` is `anthropic/claude-sonnet-4-5`, so
`ANTHROPIC_API_KEY` is the natural minimum). Keys are injected into the spawned
`pi --mode rpc` child's environment by the runner (from the workspace secrets
store) and are never logged.

Pi also accepts a per-invocation `--api-key`, but this adapter relies on the
env slots above so key material flows through the runner's secrets pipeline
rather than argv. The per-session provider override written for a console-org
profile holds only `$ENV` references, never the token itself.
