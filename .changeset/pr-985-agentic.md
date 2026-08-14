---
"@agentproto/cli": minor
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Add optional `provider` field to ACP agent specifications. This allows generic ACP adapters (Mistral Vibe, Google Gemini CLI, Moonshot Kimi CLI) to declare their billing endpoints, enabling clients to link the harness to that provider's wallets even when no model list is declared. The provider is projected through AdapterInfo and integrated into VSCode wallet linking logic.
