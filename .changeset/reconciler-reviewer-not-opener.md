---
"@agentproto/runtime": patch
---

The PR-provenance reconciler's branch lane no longer stamps a sandboxed session as a PR's opener unless an `Agentproto-Session` trailer on the PR's commits or checkpoint names it. A sandboxed reviewer whose box checked out the PR head was credited as the opener of a PR opened outside agentproto (#2447).
