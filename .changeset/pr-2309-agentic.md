---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Raise the autocompact absolute-threshold ceiling (`contextContinuity.autoCompactAtTokens`) from 200000 to 600000 tokens so a session on a 1M-token window can compact later than 200k. The default (150000) and `0` = disabled are unchanged.
