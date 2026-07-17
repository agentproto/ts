---
"@agentproto/llm-endpoint": minor
---

Replay a turn once when a stripped-thinking provider returns an empty turn.

Some reasoning models served behind a router reason and then emit nothing —
thinking blocks only, no text, no tool_use, `stop_reason: "end_turn"`. Since the
proxy strips thinking, the client receives an empty message and the turn is a
silent no-op. Measured on Requesty's sference/thinkingcap-qwen3.6-27b at ~12% of
turns, identically on that router's Anthropic and OpenAI surfaces — a model
defect, not a translation one, and `reasoning_effort` is a no-op on it.

Replaying once took the live drop rate from 12% to 2% (47/48 across streaming
and non-streaming). Scope is deliberately narrow: only `needsStrip` providers,
only HTTP 200, only `stop_reason: "end_turn"` (a `max_tokens` truncation means
the model burned its budget thinking — replaying reproduces it and bills twice),
one replay, every replay logged. `LLM_ENDPOINT_EMPTY_TURN_RETRY=0` opts out.

Streaming holds events until the first client-visible block, then commits to
passthrough. This costs no perceived latency: thinking blocks are stripped, so
nothing reached the client during the reasoning phase anyway — which is exactly
the window the empty turn plays out in.
