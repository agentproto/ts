---
"@agentproto/runtime": minor
---

Migrate the remaining misc list tools onto the `ToolTransformer` mechanism (`paginated()` + `catchErrors()` at registration instead of hand-rolled per-handler logic): `auth_profile_list`, `llm_endpoint_list_links`, `harness_preset_list`, `browser_adapter_list`, and `list_browsers`.

Every migrated tool now has a real compact projection behind the previously dead `compact`/`full`/`fields` params:

- `auth_profile_list` — compact rows drop `costBudget` (enforced daemon-side, never read by listing callers); `full: true` restores it.
- `llm_endpoint_list_links` — default rows keep the documented picker shape (`{provider, linkedProfile, eligible: [{id, label, method, endpoint}]}`); `full: true` additionally surfaces each eligible profile's remaining non-secret metadata. The legacy top-level `{ links, upstreams }` envelope is preserved (a `withLinksMap` composition transformer derives the map from the rows, which already carry `linkedProfile`).
- `harness_preset_list` — rows are pinned to the documented preset shape by an explicit allowlist.
- `browser_adapter_list` — compact rows are `{id, name, defaultPort, location?}`; the prose `description` and `install`/`config` manifest arrays move behind `full: true`. Default output changed from a bare array to `{ adapters: [...] }`.
- `list_browsers` — compact rows are the browser identity/routing fields of the session descriptor; `full: true` returns the full descriptors. Default output changed from a bare array to `{ browsers: [...] }`.

Error handling on the migrated tools is normalized by `catchErrors()` (any thrown error becomes the canonical `{content, isError}` text result). Page-walk pagination (`limit`/`cursor` → `{items, nextCursor?, total}`) is unchanged.
