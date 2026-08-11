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

Interactive login (`jcode login --provider <name>`) stores tokens in the OS
keyring / `~/.jcode/` directory — the adapter does not manage these.
