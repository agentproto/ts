---
"@agentproto/runtime": minor
---

Decouple the compaction handoff turn from `/compact`. A `/compact` or `/compress` prompt still writes a checkpoint before the harness compacts ("no checkpoint, no compaction" unchanged), but does so from the transcript alone by default — no billed handoff turn put to the live session. New `contextContinuity.compactHandoffTurn` flag (default `false`) restores the previous behaviour: when `true`, the prompt asks the live session for a handoff turn (goal, decisions, risks) before building the checkpoint. The context-rescue path (`runtime:context-rescue`) never asks, and explicit handoffs (`session_checkpoint`, `session_continue_fresh`) are unchanged.
