---
"@agentproto/runtime": patch
---

Relay `message_parent` from inside a box (E2B / computer) to its host parent.

A session running inside a box has no local parent row (the parent lives in
the HOST daemon's registry), so `message_parent` failed with "no recorded
parent". The host now forwards a remote parent (parent session id + relay URL
+ a short-lived, single-session-scoped token) into the box's own
`agent_start`; the box's `message_parent` relays the report to the host's
relay endpoint, which resolves the recipient from the token and delivers it
to the parent through the ordinary message path (kind/urgency preserved).
Without a configured relay URL the behaviour is unchanged (the current clear
error).

The relay token is treated as a secret: it never lands on a session
descriptor nor on disk (the persisted row carries only the parent session id
and the relay URL), so a box daemon that restarts fails `message_parent` with
a clear "relay token lost after restart" instead of sending an
unauthenticated report. The grant slides its expiry on every successful
relay use, is revoked when the host-side box session ends (or when the box
boot fails), and expired grants are pruned.
