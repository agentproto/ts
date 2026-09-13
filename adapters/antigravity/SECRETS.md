# Google Antigravity — Secrets / Auth

Antigravity authenticates through the **OS keyring** plus a **Google Sign-In
browser flow**. There is **no documented API-key environment variable** — you
cannot hand `agy` a key via the environment the way you would `ANTHROPIC_API_KEY`
or `OPENAI_API_KEY` for other agents.

## What this means for headless / programmatic use

`agy -p …` (headless mode) reuses whatever credentials were cached by a prior
interactive login. So:

1. **Authenticate once, interactively, on this machine:** run `agy` (no `-p`)
   and complete the Google Sign-In in the browser it opens. The tokens land in
   your OS keyring.
2. Only then will headless runs work. Per the official docs, *"In a
   non-interactive environment with no terminal (for example, CI), a run that is
   not already authenticated exits with an authentication required error instead
   of hanging."*

There is nothing for the runtime to inject or scrub — no bearer env var, no
api-key env var. The adapter simply relies on `agy`'s own cached keyring
credentials, so an unconfigured spawn stays ambient (it uses your existing
`agy` login).

## Model selection is not an auth axis here

Every model Antigravity serves (Gemini 3.x, Claude, GPT-OSS variants) is routed
through Antigravity's own backend under the **same Google identity** — there is
no per-provider API key to configure. Pick a model with `agy --model <slug>`
(see `agy models`); it does not change how you authenticate.
