---
"@agentproto/runtime": patch
---

Allow subscription profiles (oauth-bearer) on modelDerivedApiKey adapters (mastracode, opencode). These adapters now correctly expose oauth-bearer as an eligible auth method and support subscription mode by injecting the token via the model-derived provider env var.
