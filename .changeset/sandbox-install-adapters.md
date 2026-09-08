---
"@agentproto/runtime": minor
"@agentproto/sandbox": minor
---

Sandbox specs accept a semantic `config.installAdapters` field — harness slugs (e.g. `["hermes", "claude-code"]`) instead of raw npm specs. Each slug expands to `@agentproto/adapter-<slug>@latest` plus its declared boot extras and merges into `config.installPackages` alongside the spawned-adapter auto-injection, with dedupe: an explicit `config.installPackages` pin for the same package always wins, caller pins keep their order, and the expansions land after them. An unknown slug still expands (the box's npm install is the authority on resolvability); a spec without the field boots byte-identical.