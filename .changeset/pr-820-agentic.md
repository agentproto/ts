---
"@agentproto/adapter-mastra-agent": patch
---

Fix git operations escaping workspace to operate on enclosing parent repositories by setting GIT_CEILING_DIRECTORIES to prevent git from discovering repos above the workspace root.
