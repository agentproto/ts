# jcode secrets

jcode reads provider credentials from env vars or from its config directory
(`~/.config/jcode/<provider>.env`). The adapter injects credentials via env:

- `ANTHROPIC_API_KEY` — Anthropic Claude
- `OPENAI_API_KEY` — OpenAI
- `OPENROUTER_API_KEY` — OpenRouter
- `GOOGLE_API_KEY` — Google Gemini
- `DEEPSEEK_API_KEY` — DeepSeek
- `GROQ_API_KEY` — Groq
- `MISTRAL_API_KEY` — Mistral

Subscription logins (`jcode login --provider claude` for Claude Max,
`--provider openai` for ChatGPT/Codex) store OAuth tokens in
`~/.jcode/auth.json` and `~/.jcode/openai-auth.json`. The adapter declares
them as external `authSubscription` surfaces: with `auth.mode:
"subscription"` the runtime verifies the login exists, injects nothing, and
scrubs the api-key vars above. Other logins are stored by jcode itself and the
adapter does not manage them.
