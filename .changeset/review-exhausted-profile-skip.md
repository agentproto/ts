---
"@agentproto/runtime": patch
---

Review lanes skip an exhausted auth profile instead of spawning a doomed reviewer.

When the OpenCode Go quota is spent, every Go preset in a lane's `preset -> fallbackPresets` chain died with `Go usage limit exceeded [wallet: profile "opencode-go-local"]` — and each lane still SPAWNED a full agent session for every Go preset before reaching a non-Go one (390 wasted sessions across 2026-10-09..11, each a process + a transcript dir). The host now keeps a per-daemon cooldown map keyed by `profileRef` for wallet exhaustion (`usage limit`, `quota exceeded`, `insufficient credit|balance|funds` — a 15-minute cooldown that blocks every model on the drained profile) and by `profileRef::model` for `rate limit exceeded` (60s, per model: several free models share one profile on purpose, and a chain falls back across them). The next attempt resolving a blocked key returns `skipped: auth profile '<ref>' [(model '<model>')] is exhausted until <iso> (...)` WITHOUT spawning — so the chain falls through to the next fallback instantly. The clock is injectable (`deps.now`) for tests; verdicts, timeouts and `block` results are unchanged and never fall back.
