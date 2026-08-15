---
"@agentproto/cli": patch
"@agentproto/skill-pack-agentproto": patch
"@agentproto/skill-pack-bureau": patch
---

Accuracy pass on skill documentation and AGENTS.md. Fixes ~20 tool names in skill documentation to match current runtime API (agent_output, command_log_tail, file_*, terminal_*, etc.). Corrects permissions_respond schema documentation. Removes diverged duplicate SKILL.md file from packages/cli/skill/ (never imported by code but shipped in npm tarball). Updates reference documentation paths and line numbers.
