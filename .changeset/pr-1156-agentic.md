---
"@agentproto/sandbox-e2b": patch
---

Add mastra-agent adapter support and sandbox resource configuration. The mastra adapter's heavy runtime install requires 2048 MB memory (vs. e2b's 512 MB default), which would otherwise OOM. Resource flags are now validated in versions.json and threaded into build commands as required CLI arguments to `e2b template create`.
