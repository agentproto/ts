---
"@agentproto/harness": patch
"@agentproto/doctype": patch
"@agentproto/inference-endpoint": patch
"@agentproto/provider-presets": patch
"@agentproto/adapter-mastracode-inprocess": patch
"@agentproto/adapter-pi": patch
"@agentproto/driver-cli": patch
"@agentproto/mcp-server": patch
---

Release and doc hygiene after the AIP-70 renames: fix remaining old package
names and dead paths, add the missing harness and doctype READMEs, document
the `inference-endpoint` command alongside its `llm-endpoint` alias, and
classify the AIP-70 rename shims as archived in STATUS.md.
