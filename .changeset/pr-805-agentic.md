---
"@agentproto/runtime": minor
---

Default `agent_start` dedupe to deriving an implicit idempotency key. A retry provoked by a lost or slow response previously forked a second session unless the caller remembered to pass `idempotencyKey` — a guard that only works when asked for is not a guard, the same argument `spawn.attach` already settled for parent lineage. New daemon-side `spawn.dedupe` policy on `SpawnConfig` (`AGENTPROTO_SPAWN_DEDUPE` env > config > default `"always"`), which derives a key from `label` + a hash of the initial prompt. No label means no implicit key at all, so deliberate unlabelled parallel fan-out into one cwd is structurally excluded. Implicit claims use a shorter window (120s) than explicit ones (600s) — a guess should not be trusted as long as a promise. Per-call `dedupe: false` opts out, mirroring `attach: false`; `dedupeSource: "explicit" | "implicit"` is surfaced on the result so a caller can tell the two apart.
