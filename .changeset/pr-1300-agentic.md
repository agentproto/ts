---
"agentproto-vscode": patch
---

Fix standalone app URL encoding: encode scoped appIds per path segment and keep `@` and `/` literal, so deep links read `/apps/@scope/name/ui` while still escaping characters that genuinely need it.
