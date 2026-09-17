---
"@agentproto/apps": patch
"@agentproto/runtime": patch
---

MCP-Apps hosts with opaque widget origins (e.g. Claude Desktop) can now mount an app's `/ui` page: a per-boot embed token is baked into panel bridge scripts at registration and accepted (alongside `vscode-webview:` and `csp.frameDomains`) as a trusted-embedder proof by `handleAppUiPage`/`applyCors`, layered under the existing bearer-auth and `sec-fetch-dest: iframe` gates.
