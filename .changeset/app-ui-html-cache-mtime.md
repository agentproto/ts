---
"@agentproto/runtime": patch
---

Fix stale installed-app UI panels after a committed `ui/index.html` bundle is rebuilt in place (e.g. a merged PR). `createUiHtmlCache` (app-ui-apps.ts, used by `makeInstalledAppUiApps` for the MCP `tools/list`/`resources/read` path) keyed its per-path cache on `app.updatedAt` alone, which only changes on `app_install` — so the daemon kept serving the old HTML until the app was reinstalled or the daemon restarted. It now also `stat`s the file and folds `mtimeMs:size` into the cache key, so an in-place rewrite invalidates immediately with no reinstall needed. The HTTP `GET /apps/:appId/ui` path already versioned on the file's own stat and needed no change.
