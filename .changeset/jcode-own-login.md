---
"@agentproto/adapter-jcode": minor
"@agentproto/secrets": minor
---

jcode now declares its own Claude Max and ChatGPT logins (`jcode login --provider claude|openai`) as external subscription surfaces, so `auth.mode: "subscription"` verifies the login instead of requiring an API key. `@agentproto/secrets` gains the `jcode` provision recipe (`anthropic-oauth` → `~/.jcode/auth.json`, `openai-oauth` → `~/.jcode/openai-auth.json`).
