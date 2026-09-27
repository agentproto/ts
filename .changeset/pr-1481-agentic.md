---
"@agentproto/cli": minor
---

Add `agentproto settings export|import`: snapshot a machine's setup (installed adapters, harness presets, auth-profile metadata, LLM endpoints, imported-MCP pointers, sanitized config.json) into a versioned JSON bundle and apply it additively to another machine, with opt-in passphrase-sealed secret restore (`--include-secrets` / `--passphrase-env` / `--unseal-passphrase-env`) and `--dry-run` preview.
