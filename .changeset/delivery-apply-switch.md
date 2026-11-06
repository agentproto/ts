---
"@agentproto/delivery": minor
"@agentproto/sentinel": minor
"@agentproto/runtime": minor
---

Add the `delivery.apply.types` switch so a classified level can drive delivery (wake/fyi/drop; an applied level 3 is delivered as a wake and never downgraded or dropped) per event type, shadow by default, for both session follows and sentinels.
