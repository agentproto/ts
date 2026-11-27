---
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

`GET /store` (and so `agentproto app store` and the install links apps point at) now redirects to the installed `@agentproto/app-store` app when it is installed and can serve its page (its UI bundle exists, or a `ui.build` can produce it), instead of always opening the builtin `@agentproto/store` panel. A machine with the app installed no longer shows two different App Stores; the builtin panel stays the fallback on a fresh daemon.
