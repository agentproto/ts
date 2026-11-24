---
"@agentproto/adapter-knowledge-files": patch
---

Disposing an adapter while its on-disk index build or reconcile was running could leave that build waiting forever: a request the build posted after the worker's `close` was dropped when the worker was terminated, and nothing rejected it. The build then held the process-wide build lock, so every later index build in the process (on disk or in memory) stalled and queries timed out with no hits. Closing the worker now rejects every request still pending, and the worker's exit always does too.
