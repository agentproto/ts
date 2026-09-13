---
"agentproto-vscode": minor
---

Add `agentproto.appPanelMode` setting: render app panels as a direct HTTP iframe at the daemon's standalone app host (`iframe`, for installed apps with a `ui` block) or the existing self-contained srcdoc relay (`srcdoc`, default, works for every app). Apps without a `ui` block silently fall back to srcdoc.
