---
"@agentproto/adapter-gemini": minor
"@agentproto/cli": patch
"@agentproto/runtime": patch
"agentproto-vscode": patch
---

Add native `@agentproto/adapter-gemini` AIP-45 adapter for Google's Gemini CLI in ACP mode, with file-based subscription auth ("use my existing Gemini login" via ~/.gemini/oauth_creds.json). Includes comprehensive spawn and auth resolution tests, VSCode profile flow integration, and catalog entry.
