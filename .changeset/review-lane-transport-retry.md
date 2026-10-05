---
"@agentproto/runtime": patch
---

An agent review lane whose reviewer turn ends in a transient error (dropped socket, 5xx, overloaded provider) is now retried once in a fresh reviewer session sharing the lane's `timeoutMs`; set `review.laneRetries` in the daemon config to change it (`0` disables). Credential, quota and unknown-model errors are never retried. A failed lane now reports the adapter's own error text and attempt count instead of "commonly an auth failure".
