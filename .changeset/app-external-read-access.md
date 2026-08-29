---
"@agentproto/runtime": minor
"@agentproto/app-kit": minor
---

Add a new opt-in, read-only external filesystem plane for installed apps: an app can declare `externalReadRoots` (a manifest field on `AppDefinition`/`AppHandle`/`AppFrontmatter`/`InstalledApp`) to be granted read access to a real host folder outside the daemon's sandbox — e.g. a user's actual `~/Downloads/applications` — without touching the existing app-data (app-owned dir) or fs-tools (workspace-root) planes.

Each root is `~`-expanded, resolved absolute, and validated to exist as a real directory at install time (`app_install`/`app_apply` fail fast otherwise). Two new MCP tools (`app_external_list`, `app_external_read`) and a new `GET /apps/:appId/external-blob?root=&path=` HTTP route read from a granted root only when the caller's `root` argument is an exact match — no prefix/fuzzy matching. `app_external_read` serves only an allowlist of text-ish extensions under a 2MB cap; binary content (PDFs, images, …) streams through the HTTP route instead. There is no write or delete tool for these roots anywhere in the daemon.
