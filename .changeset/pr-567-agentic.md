---
"agentproto-vscode": minor
---

Add scriptable login flow for Anthropic subscription authentication. Users can now run `claude setup-token` directly within the VS Code extension to generate tokens, improving UX and reducing manual token-finding steps. New exports: `loginCommandFor()` and `credentialSourceChoices()`.
