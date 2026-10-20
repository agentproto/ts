---
"@agentproto/runtime": patch
"@agentproto/sandbox": patch
"@agentproto/sandbox-computer": patch
---

Detach and tear down computer boxes on session kill, crash, and shared-box survivor teardown. A killed session on a shared box now releases its provider/controller slot without stopping the box under the survivors, an operator kill on an already-ended (crashed-adapter) sandbox row retries box teardown, and the computer provider's holder-scoped detach is idempotent. Adds an optional `detach()` seam to `BootedSandbox`/`SandboxAgentSessionHost`. Note: the PR already carries an equivalent changeset (`.changeset/computer-box-detach-leaks.md`); this file is only a reviewer handoff.
