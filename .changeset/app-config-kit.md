---
"@agentproto/app-config": minor
---

New package `@agentproto/app-config` — layered YAML config kit for agentproto apps, generalized from @agstudio/book-config. `defineAppConfig({ app, item, itemsKey, defaultsKey })` returns a typed kit: `load()` merges app-level defaults → app `items[]` entry → item file (deep for objects, arrays replace), emits input-io JSON Schemas (defaulted fields not required), generates per-item contract files with canonical-JSON sha256 drift check, runs declarative config gates, and composes gates + contracts + caller scopes into one verify report — plus a minimal CLI (`check | schema | contracts [--check] | verify`) over an `app.config.ts` kit instance so an app's `verify.command` can call the kit.
