---
name: hermes-secrets
id: hermes-secrets
description: Secret slots Hermes Agent reads at boot. At minimum one model-provider key MUST be present; additional integrations (search, voice, vision providers) optionally widen the operator's tool surface.
version: 0.1.0
slots:
  - name: ANTHROPIC_API_KEY
    description: Anthropic API key — enables claude-* models.
    required: false
    sensitivity: high
  - name: OPENROUTER_API_KEY
    description: OpenRouter API key — enables 200+ models behind one provider.
    required: false
    sensitivity: high
  - name: OPENAI_API_KEY
    description: OpenAI API key — enables gpt-* models.
    required: false
    sensitivity: high
  - name: GEMINI_API_KEY
    description: Google Gemini API key.
    required: false
    sensitivity: high
  - name: GROQ_API_KEY
    description: Groq inference API key.
    required: false
    sensitivity: high
constraints:
  - kind: at-least-one-of
    of:
      - ANTHROPIC_API_KEY
      - OPENROUTER_API_KEY
      - OPENAI_API_KEY
      - GEMINI_API_KEY
      - GROQ_API_KEY
tags: [hermes, secrets, model-providers]
---

# Hermes Agent — secrets inventory

Hermes routes turns to whichever model the operator selects (or its
own default) and reads provider keys from the environment. The
`at-least-one-of` constraint enforces that at least one provider is
configured before spawn; the runner refuses to start otherwise.

## Threat surface

- Provider keys leak via misconfigured logging or a tool call that
  shells out with `env | grep API_KEY`. Hosts MUST scrub provider
  env from any user-visible diagnostic output.
- Hermes' own plugin layer (memory, image-gen) may read additional
  env vars not enumerated here. The host SHOULD pass only the slots
  declared in this manifest, no broader passthrough.

## Operator binding

The operator's secret store resolves these slots and the runner
injects them via `sandbox.env.set`. Tools the operator does not have
permission to use (per AIP-7 governance) MUST NOT receive the
matching key.
