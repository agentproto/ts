---
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

New daemon config key `daemon.frameAncestors` lets the operator choose who may frame the app page `GET /apps/:appId/ui`, for example `agentproto config set daemon.frameAncestors https://web.telegram.org,https://webk.telegram.org,https://webz.telegram.org` so a browser-based Telegram client can open an app link inside its iframe. `agentproto serve` validates the list (exact `https://host[:port]` origins, plain `http://` on loopback only, custom schemes such as `vscode-webview:`; never `*`, wildcards, bare `http:`/`https:`, paths or keywords, each dropped with one warning) and passes it to `createGateway({ frameAncestors })`, which forwards it to the HTTP server. With the key absent the response headers are unchanged.
