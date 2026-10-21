---
"@agentproto/runtime": minor
---

Session-follow digests now have a deterministic **triage** stage: every event is classified `wake` / `fyi` / `drop` BEFORE a digest is allowed to wake the follower, so an orchestrator that follows many sessions is no longer woken by dozens of digests an hour that ask for nothing. No LLM is involved, and the whole stage is **disabled by default** - a follow without `triage.enabled` behaves exactly as before.

The rules, each independently switchable: a `task-changed` the follower made itself is `drop`ped; an `exited` with reason `operator-stopped` / `operator-completed` is `fyi`; an `exited` whose cron run finished OK is `drop`ped; a `turn-end` from a session that reported up to the follower in the last `reportWindowMs` (60s) is `drop`ped (the report already arrived); an empty/cancelled `turn-end` that a new turn superseded is `fyi`; a `pr-opened` / `pr-merged` authored by another live session of the follower is `fyi`. Always wake: `awaiting-input`, `crashed`, and a turn-end carrying a question.

A digest whose events are all `fyi`/`drop` never wakes - it is parked in the follower's inbox as `fyi`. One `wake` is enough to wake, and the digest then carries only the `wake` events plus a `[session-follow] N other event(s) in info` counter. Every triaged event is appended to `~/.agentproto/follow-triage.jsonl` (`{ ts, follower, event, sessionId, decision, rule }`) as training data.

Configured per follow (`session_follow`'s `triage: { enabled, rules, reportWindowMs? }`) and daemon-wide (`~/.agentproto/config.json` -> `follow.triage`); the follow's own block wins, per field (a rule set `false` on a follow switches it off; among follows sharing a digest, ON wins). The `classifier` block, daemon config only (it runs a command / HTTP call on the host, so `session_follow` rejects it), is the documented extension point for a future LLM classifier (Jev): it receives the event as JSON and answers `wake`/`fyi`/`drop`; on timeout, error, or an unparsable answer the deterministic rules decide instead.
