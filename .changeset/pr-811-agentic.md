---
"@agentproto/app-kit": minor
---

Add `loadAppHandle(dir)` function to load previously emitted app bundles, and support optional app identity fields (id/name/version/description) in `defineApp`. The emit now always writes a root `APP.md` index manifest that a future daemon `app_install` can discover and consume.
