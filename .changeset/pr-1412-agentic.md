---
"@agentproto/acp": minor
---

Add orphaned-prompt recovery: a `session/prompt` folded into an agent's autonomous cycle (autonomous-origin result frame followed by silence) is cancelled after `orphanedPromptTimeoutMs` (default 60s, `0` disables) and reported `completed` instead of leaving the session busy forever.
