---
"@agentproto/runtime": patch
---

Separate daemon-composed system prompts from user prompts in transcripts. The role disposition (and other daemon-synthesized preambles like lineage, AGENTS.md) are now recorded as a distinct `system-prompt` event ahead of the `user-prompt`, allowing viewers to fold synthesized context instead of rendering it as a user bubble. The adapter still receives the single composed prompt unchanged; the split is recording-only on the daemon's event stream.
