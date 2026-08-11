---
"@agentproto/adapter-mastra-agent": patch
"@agentproto/runtime": patch
---

Fix tool resolution failures in mastra-agent adapter: introduce fail-fast stubs for declared-but-unwired tools (preventing hangs), wrap all tools with timeout guards (preventing unbounded blocking), add daemon-style tool ID aliases (fixing vocabulary mismatches in AGENT.md files), and properly handle tool-error chunks from Mastra (preventing tool calls from appearing stuck). Extract shared command-allowlist logic to runtime package for reuse.
