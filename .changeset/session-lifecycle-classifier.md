---
"@agentproto/runtime": minor
---

Follow triage rules now live behind the `session-lifecycle` delivery
classifier, built in the runtime and closing over the follow facts. Session
follow signals produce delivery envelopes carrying a `floor` for
awaiting-input, crashed, and turn-end-with-a-question, and `computeLevel`
turns that floor into level 3. The three separate always-wake pins (the rule
branch, the classifier guard, and the digest urgency bump) are replaced by
that one floor, so an empty classifier registry still pins a floored
`session.awaiting_input` envelope at level 3 and a `fyi` digest containing
one is delivered as `next-turn`. Delivery with triage off is unchanged.
