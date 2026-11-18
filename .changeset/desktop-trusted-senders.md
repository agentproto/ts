---
"@agentproto/runtime": minor
---

Opt-in trusted senders for the Codex Desktop direct wake: `daemon.desktopTrustedSenders` (`off` default | `operator` | `tree` | an explicit list of session ids, `label:<x>`, `human` or `claude-desktop`) and a per-chat `daemon.desktopTrustedSendersByThread`. A message from a trusted sender reaches the chat as an instruction in the turn text with the sender named, instead of as `untrusted_input` data. System and anonymous senders and external rows are never trusted; the unverified `claude-desktop` identity only when listed. Off by default, restart to apply, read-only over MCP.
