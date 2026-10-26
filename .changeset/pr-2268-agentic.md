---
"@agentproto/runtime": minor
---

Expose reaction runner health through a new `ReactionRunner.health()` read model and a read-only `GET /reactions` HTTP route, add a `ReactionWiring.current()` accessor, and emit one structured trace line per terminal reaction transition on a separate `trace` channel.
