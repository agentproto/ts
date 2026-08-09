---
"@agentproto/cli": patch
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Implement turn-liveness watchdog: detect mid-turn agent-cli sessions with dead adapter streams.

The daemon periodically sweeps every BUSY agent-cli session and, for one that is mid-turn, NOT legitimately blockedOn a subagent/command, and has had no adapter activity for longer than the configured threshold (default: 5 minutes), stamps `stalledSinceMs` on the descriptor and emits `session:stalled` — surfacing a dead adapter stream (network drop, hung child) that would otherwise sit indistinguishable from healthy long work. Detection and observability only; never auto-kills or restarts. Threshold configurable via `daemon.turnStallAfterMs` config or `AGENTPROTO_TURN_STALL_AFTER_MS` env var (DEFAULT ON, opt-in-to-disable). VS Code displays the stall flag (⚠ badge) when the daemon confirms, with a tooltip showing the silent duration.
