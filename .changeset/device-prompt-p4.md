---
"@agentproto/runtime": patch
"@agentproto/cli": patch
"@agentproto/pairing-host": patch
"@agentproto/acp": patch
---

Controller→host-session prompt path + E2E channel flap diagnostics (BOOTSTRAP P4)

- `runtime`: `device_prompt` MCP tool + `POST /devices/:id/sessions/:sessionId/prompt` —
  write a turn to a session on a registered HOST device (the write counterpart of
  `device_sessions`), forwarded over the host's E2E channel with `agent_prompt`'s
  queueing rules (fire-and-forget default, FIFO behind an in-flight turn,
  `interrupt`/`force`; `wait` blocks until the turn drains). The host side serves
  `POST /device-prompt/:sessionId`, self-proxying onto its own
  `POST /sessions/:id/prompt`, gated by the same two gates as `/device-spawn/*`
  (host-scoped pairing + `features.deviceSpawnAllow` — a plain remote-control
  pairing never gets it). CLI: `agentproto devices prompt <fp|name> --session <id>
  --prompt <text> [--wait]`.
- `runtime`: post-handshake E2E diagnostics in `HostRegistry.connectToHost` —
  each failed attempt logs the host name/fingerprint, attempt number, and the step
  it died at; a host that closes AFTER completing the Noise handshake now fails
  immediately with the remote close reason instead of masking it behind a 10s
  tunnel-hello timeout (the step the observed flaps break at), and the re-pair
  hint now also fires on a hello timeout.
- `pairing-host`: the daemon's pairing accept-loop no longer swallows handshake
  failures silently — the gated log names the step (`transport closed during
  handshake: <reason>` vs a hello timeout), and the channel-closed log carries the
  remote close reason.
- `acp`: `daemonHandshakeOverSink` takes an optional `log` hook that surfaces the
  remote's POST-REPLY close reason — the exact step the observed E2E flaps break
  at (Noise OK, reply sent, controller hangs up). Wired into the pairing accept
  loop (gated, labelled with the loop key) and the join-token accept loop; the
  reason was previously captured at this layer and discarded.
