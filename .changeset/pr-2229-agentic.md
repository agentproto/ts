---
"@agentproto/runtime": minor
---

Add the durable AIP-71 reaction receipt store for action hooks. The new exports (`createReactionReceiptStore`, `buildReactionReceiptKey`, `ReceiptTransitionError`, `RECEIPT_REDACTION_REVISION`, and the receipt types/options) provide durable pending/running/terminal writes, a five-state lifecycle, redaction, retention, and load-time validation. Persistence is enabled by default when using the built-in receipt path.
