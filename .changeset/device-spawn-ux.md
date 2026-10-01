---
"@agentproto/runtime": patch
---

fix(device-spawn): retry a flapping host channel once, and surface the host's
first-turn failure. Two device-spawn UX defects from cross-device field
dogfood (Mac Studio → Windows 11 / Mac Pro hosts):

- **Silent spawn hang.** A `device:<fp>` spawn whose E2E channel to the host
  was flapping failed with a transport-class error and surfaced as a bare MCP
  `Request timed out` — no retry, no actionable message. The inner
  `agent_start` over the host channel is now wrapped in ONE automatic retry
  with a ~2s back-off on transport-class failures (`device_unreachable`,
  `transport closed`, `handshake timed out`, `ECONNRESET`, …); on a spent
  budget it returns `device_spawn_unreachable` (HTTP 400) naming the target,
  the attempts, and the guidance to retry / run `agentproto devices status`.
  Non-transport failures (the host's own `adapter_not_found`, a bad model id)
  still fail immediately, and local/e2b/Box spawns are unchanged.
- **Silent empty turns on a bad model id.** A device spawn whose model id did
  not resolve on the host completed its first turn EMPTY, leaving a
  healthy-looking `running` session while the adapter's real
  "model not found"/"invalid model" line sat only in the host's ring buffer.
  The sandbox proxy now surfaces that raw host line as a `notice` on a
  failed/empty FIRST turn (rendered into `agent_output`), and the descriptor
  is stamped `firstTurnFailed: true`.
