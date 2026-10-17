---
"@agentproto/adapter-browser-chrome": minor
---

chrome-live now prefers a dedicated, zero-consent headful Chrome by default: a bare `launch({})` launches (or reuses, hot) its own Chrome immediately, with no attach attempt and no consent wait. Attaching to the user's own Chrome through the remote-debugging toggle now requires an explicit ask — a pinned `wsUrl`/`port` (launch opts, provider config, or `CHROME_LIVE_*` env), a new `attachIntent: true` launch option, or the new `preferDedicated: false` provider-config flag. The attach path still falls back to the dedicated Chrome when it cannot connect, and a pinned endpoint is still taken literally. `pinnedEndpoint` and `wantsAttachFirst` are exported for testing the routing decision without a real Chrome.
