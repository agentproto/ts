---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Reap idle sandboxed sessions and tear their box down. New `daemon.sandboxIdleReapAfterMs` (env `AGENTPROTO_SANDBOX_IDLE_REAP_AFTER_MS`, default 15 min, `0` = off) applies a shorter idle threshold to sessions running in a provider box. A reap takes a final checkpoint, then stops the box per the lifecycle policy (kill unless the spec asked to pause), and records `reapedAt`/`reapedIdleMs`/`reapedSessionId` in the sandbox ledger. A later prompt to the reaped row cold-boots a fresh box from the checkpoint branch and delivers the prompt there. Non-sandbox sessions are unchanged.
