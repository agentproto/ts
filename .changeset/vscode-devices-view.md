---
"agentproto-vscode": minor
---

Add a Devices view: this machine plus every paired device (client/host) from `GET /devices`, with name/role/kind/online status/last-seen/scope, lazy drill-down into a host's remote sessions (`GET /devices/:id/sessions`), and click-through to a session's output tail. Context-menu actions cover rename, revoke (with a confirm dialog), and copy fingerprint.
