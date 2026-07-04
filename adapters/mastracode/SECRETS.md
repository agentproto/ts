# Mastra Code — Secrets / Auth

Mastra Code supports multiple AI providers:

| Provider | Environment Variable |
|----------|---------------------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` |

In addition to API keys, Mastra Code supports OAuth authentication
for Anthropic (Claude Max) and OpenAI (ChatGPT Plus / Codex) via
the `/login` slash command in TUI mode. OAuth tokens are stored in
Mastra Code's local settings store and are not environment-variable
based.

For headless / programmatic use, set the provider's API key via the
corresponding environment variable. Multiple providers can be
configured simultaneously — the `--model` flag selects which one
is active for a given run.
