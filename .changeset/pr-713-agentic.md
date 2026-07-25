---
"@agentproto/cli": patch
"@agentproto/runtime": minor
"@agentproto/sandbox": minor
"@agentproto/sandbox-box": minor
"@agentproto/sandbox-e2b": minor
---

Add `agentproto sandbox attach` — Phase 1 of AIP-36 sandbox reconnect. New CLI verb and runtime primitives (`attachSandbox`, `buildMcpConfigSnippet`, `registerSandboxAttachTool`) for connecting to already-existing sandboxes without tearing them down. Returns durable, token-gated connection descriptors for any MCP client to use directly. Extends `SandboxProvider` with optional `connect()` method for resume-after-pause workflows, and adds token capture from Box's `--private` and e2b's traffic restriction.
