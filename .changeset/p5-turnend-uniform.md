---
"@agentproto/runtime": patch
---

Guarantee a terminal `turn-end` for every agent turn. When an adapter's
event stream ends without emitting one — the subprocess crashed/exited
non-zero (e.g. the mastracode ENOBUFS case), the generator returned early,
the turn threw, or it was aborted — the runtime now synthesizes exactly one
`turn-end` (tagged `exited` / `error` / `aborted`) and stamps
`turnsCompleted`, so downstream orchestration can rely on `turn-end` as a
uniform completion signal instead of hanging. Idempotent: no second
`turn-end` is emitted when the adapter already produced one.
