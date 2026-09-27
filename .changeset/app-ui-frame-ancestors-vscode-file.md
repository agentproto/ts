---
"@agentproto/runtime": patch
---

`GET /apps/:appId/ui` now allows `vscode-file:` in its default `frame-ancestors` CSP alongside `vscode-webview:`. In VS Code desktop, CSP checks every frame ancestor up to the top of the tree, and the workbench document itself loads from `vscode-file://vscode-app/...` above the webview frame, so the HTTP-iframe app panel (`agentproto.appPanelMode="iframe"`) was blocked outright with a blank panel and a CSP console error.
