---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

AIP-36 amendment "shared sandbox" — ATTACH / DETACH lifecycle. A provider box can host several sessions at once (`reuse`/`attach`): the sandbox ledger is the durable refcount (`attachedSessions`, robust to a daemon restart). Session teardown is by default a DETACH — stopping session 1 of 2 never kills the box — and only the last remaining session tears the box down. Failed boots/setup of an attaching session detach instead of stopping a shared box (survivors are preserved for a paused box), and `agentproto sandbox list` shows the attached sessions.
