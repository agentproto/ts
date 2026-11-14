---
"@agentproto/adapter-mastra-agent": patch
---

Fix Mastra adapter startup in macOS app sandboxes by granting read access to
its built runtime and installed dependencies while keeping unrelated workspace
files confined.
