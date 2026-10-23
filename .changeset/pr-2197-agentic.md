---
"@agentproto/runtime": patch
---

Quiesce active workflow runs (cancel, wait for lease release, flush persistence) before tmpdir teardown in the workflow-retry tests, deflaking teardown against late asynchronous writes.
