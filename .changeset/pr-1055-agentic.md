---
"@agentproto/cli": patch
"@agentproto/runtime": patch
"@agentproto/worktree": patch
---

Fix critical production incident (2026-08-22) where running daemon sessions' own working directories were incorrectly deleted by worktree GC. Root cause: `computeLiveness` was defaulting to the frozen legacy sessions file instead of reading per-workspace bucket files (AIP-46). Also adds `protectedPaths` mechanism as belt-and-suspenders protection, wiring the daemon's live in-memory session registry to prevent TOCTOU races between plan and apply.
