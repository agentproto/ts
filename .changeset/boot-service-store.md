---
"@agentproto/runtime": patch
---

Fix the daemon boot re-ensure of app services: the gateway now creates one service-owner store and shares it with both `registerAppTools` and the boot pass, so leftover children from the previous daemon are found and killed and the fresh owners are persisted.
