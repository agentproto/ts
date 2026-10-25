---
"@agentproto/runtime": minor
"@agentproto/routine": patch
---

Wire AIP-41 `schedule.kind: "event"` routines into the daemon: `createReactionWiring`/`sessionFactsOf` turn resolved event bindings into reaction bindings, and `ReactionRunner.replaceBindings` hot-swaps the live binding set on every reconcile/boot. The agent-arm guard now fails closed when an event's session facts cannot be read.

Document how event routines are resolved in the routine README.
