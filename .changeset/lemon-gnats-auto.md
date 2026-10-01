---
"@agentproto/harness": minor
"@agentproto/runtime": patch
---

Send a device spawn's first prompt inside agent_start, in one dial

`StartAgentArgs.prompt` now accepts a content block / block array (not just a
string), exposing the inner `agent_start` schema's existing verbatim-prompt
capability to harness callers; the device-sandbox bridge uses it to carry the
controller-composed prompt in the spawn dial.
