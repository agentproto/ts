---
"@agentproto/runtime": minor
---

App catalog v1: remote catalogs follow the `app-catalog/v1` format (optional `version`, `tier`, `icon`, `publisher`, `license`, `requires`, `minAgentprotoVersion`, `featured`, bundle `size`); `app_catalog` always queries a default public catalog (config `catalog.defaultSource`, `false` to turn it off) to which `catalog.sources` are added; each source's last good copy is cached under `~/.agentproto/cache/catalog` and served `stale` when the source fails, with an embedded first-party list as the default catalog's offline fallback. Remote entries now report `origin` and `catalogUrl`.
