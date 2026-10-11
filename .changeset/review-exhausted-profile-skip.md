---
"@agentproto/runtime": patch
---

Review lanes skip an exhausted auth profile instead of spawning a doomed reviewer.

When the OpenCode Go quota is spent, every Go preset in a lane's `preset -> fallbackPresets` chain died with `Go usage limit exceeded [wallet: profile "opencode-go-local"]` — and each lane still SPAWNED a full agent session for every Go preset before reaching a non-Go one (390 wasted sessions across 2026-10-09..11, each a process + a transcript dir). The host now keeps a per-daemon `profileRef -> { until, error }` map: an attempt whose error matches a wallet-exhaustion line (`usage limit`, `quota exceeded`, `insufficient credit|balance|funds`, `rate limit exceeded`) records its profile with a 15-minute cooldown (60s for a rate limit), and the next attempt resolving that profile returns `skipped: auth profile '<ref>' is exhausted until <iso> (...)` WITHOUT spawning — so the chain falls through to the next fallback instantly. The clock is injectable (`deps.now`) for tests; verdicts, timeouts and `block` results are unchanged and never fall back.
