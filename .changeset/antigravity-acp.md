---
"@agentproto/adapter-antigravity": major
"@agentproto/adapter-gemini": patch
"@agentproto/cli": patch
---

Antigravity adapter: switch from the print/headless arm to the first-party ACP server (`agy acp`, agy >= 1.5.13). Drops the argv `model`/`effort`/`print_timeout` options, which `agy acp` does not accept. Gemini CLI is replaced by Antigravity: the gemini adapter and its catalog entry are marked deprecated, and first-run prefers antigravity.
