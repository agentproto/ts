---
"@agentproto/apps": minor
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Add the App Store builtin panel (`@agentproto/store`, tool `agentproto_store`): the browse/install surface over `app_catalog` / `app_list` / `app_updates`, with confirmed installs (`app_install` issued from an app panel's tool-call surface now answers a `{needsConfirmation}` preview first and installs only on a second call echoing the preview's `confirm` token; direct MCP/CLI calls are unchanged), `app_resync` / `app_uninstall` actions, install-from-URL, catalog sources warnings, builtin panels, and `GET /store` redirecting to `/apps/@agentproto/store/ui` with the query preserved. VS Code: `agentproto.openStore` command.
