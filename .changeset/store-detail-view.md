---
"@agentproto/apps": minor
---

App Store panel: add an app detail view, icons and search. Clicking a card title or icon opens `?app=<appId>` (pushState/popstate, "← Back to store") showing icon, publisher, version and update badge, license, tier, size, origin/catalog (+ stale), requires, pinned source, install/data dirs (with a missing-dir warning), agents, workflows and the last 10 runs, with Install (existing two-step confirmation), Update, Uninstall and Open. A Copy block gives the equivalent CLI commands and the exact `app_install` MCP arguments (builtins show their MCP tool id / resource URI instead). Cards show the catalog `icon` and fall back to an initial-letter tile when the image is missing, unsafe or blocked by the host's CSP. A search box (name / appId / description / publisher) and category chips filter every section, with state in `?q=` / `?cat=` and an empty-result message. History writes refused by a host iframe degrade to in-panel navigation.
