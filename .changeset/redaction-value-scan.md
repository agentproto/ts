---
"@agentproto/redaction": minor
"@agentproto/runtime": patch
---

Value-content secret scanning. `@agentproto/redaction` gains a `value-scan`
redactor that deep-walks string VALUES and masks well-known secret shapes
(prefixed API keys like `sk-…`/`sk-ant-…`, JWTs, PEM private key blocks, AWS
access keys, GitHub/Slack/Google tokens, `Bearer`/`Basic` scheme tokens) —
regardless of the key they sit under. This closes the deny-list's blind spot: a
credential embedded in an innocuously-named field (`{ note: "use sk-live-…" }`)
was previously invisible to the key-based mask. Patterns are prefix-anchored and
linear, so they can't backtrack pathologically. A `secrets` convenience slug
chains `deny-list` + `value-scan`.

`@agentproto/runtime`'s default session-trace redactor is bumped from
`deny-list` to `secrets`, so opt-in Langfuse tracing now scrubs value-embedded
secrets by default. Override via `defaults.traceRedactor`.
