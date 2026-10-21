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
