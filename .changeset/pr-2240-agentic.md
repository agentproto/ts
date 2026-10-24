---
"@agentproto/runtime": minor
---

Add the generic durable reaction runner over the reaction receipt store: single-flight execution, deterministic retry backoff, recursion capping, boot reconciliation and a retry/sweep tick. Exposes `createReactionRunner` and the `ReactionTarget`, `ReactionBinding`, `ReactionRunner` and related types.
