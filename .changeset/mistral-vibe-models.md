---
"@agentproto/cli": patch
---

Align the `mistral-vibe` generic ACP harness's model list with what Vibe 2.24.1 accepts: `mistral-medium-3.5` (default), `devstral-small` and `local`. The previous 12 declared ids (e.g. `devstral-latest`) were rejected with "Unsupported config option model" and the session silently fell back to the default.
