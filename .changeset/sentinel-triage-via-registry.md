---
"@agentproto/delivery": minor
"@agentproto/delivery-github": minor
"@agentproto/sentinel": minor
---

Move GitHub delivery knowledge out of the kernel: sentinel triage now runs
through the delivery classifier registry, GitHub verdicts, the explicit triage
table from #2444, coalesce keys and repeat keys live in
`@agentproto/delivery-github`, and `sentinel` composes that module next to
`createSentinelRuntime`. The kernel drops `ClassifyContext.facts` and
`Classifier.repeatKey`; `SentinelEvent` now extends the delivery `Envelope`.
GitHub failures carry no repeat key, so a repeated failure on the same head
still wakes.
