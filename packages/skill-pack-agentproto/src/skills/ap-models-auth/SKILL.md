---
name: ap-models-auth
description: Manage models, billing profiles, and spend on the agentproto daemon — catalog_models for runnable routes, auth_profile_create/import/set_models for named credentials, harness presets, usage_rollup for spend estimates. Trigger when asked about models, costs, billing, auth profiles, OpenRouter routing, or how much a session spent.
---

# ap-models-auth

## When to use

- Before spawning: which models are actually runnable given the auth profiles on this host.
- A spawn is rejected or bills through the wrong wallet — check/curate profiles.
- "How much did we spend this week?" — rolling spend estimates.

## Catalog: what is spawnable

```json
// Spawnable routes, profile-aware runnable flags
catalog_models({ "adapter": "claude-code", "runnableOnly": true })
// → [{ "vendor": "z-ai", "product": "glm-5.2", "route": "openrouter", "runnable": true }, ...]

// Exhaustive per-provider list (for a picker UI)
catalog_provider_models({ "endpoint": "openrouter" })
```

Model identity is `vendor/product` with an optional `@route` for transport/billing — e.g. `z-ai/glm-5.2@openrouter`. The route is distinct from the product identity: the same product can exist on several routes with different cost/limits.

## Auth profiles: named wallets

```json
// What exists (non-secret metadata + keyStatus)
auth_profile_list({ "endpoint": "anthropic" })

// Import an existing credential discovered on this host (claude-code login, env vars, hermes config)
auth_discover_credentials({})
auth_profile_import({ "origin": "claude-code", "endpoint": "anthropic", "id": "anthropic-sub" })

// Create explicitly — the secret is stored, never echoed
auth_profile_create({ "id": "openrouter-env", "endpoint": "openrouter", "method": "api-key", "credential": "sk-or-..." })

// Curate: enable/disable; narrow to a model allowlist
auth_profile_set_enabled({ "id": "openrouter-env", "enabled": false })
auth_profile_set_models({ "id": "openrouter-env", "mode": "allow", "ids": ["z-ai/glm-5.2", "deepseek/deepseek-v4-pro"] })
```

Profiles are **named** — spawn with `access: { "profileRef": "openrouter-env" }` to bill through one. A disabled profile drops every model it would serve to non-runnable, immediately.

## Harness presets: pin harness → profile + model

```json
harness_preset_create({ "id": "hm-cheap", "harnessSlug": "hermes", "name": "Cheap",
  "profileRef": "openrouter-env", "defaultModel": "z-ai/glm-5.2" })
harness_preset_list({ "harnessSlug": "hermes" })
```

A preset is what a fresh spawn uses when the caller pins neither profile nor model.

## Spend: rolling estimates

```json
usage_rollup({ "window": "5h", "groupBy": ["profile", "model", "harness"], "probe": false })
```

`basis` is always `local-estimate`: aggregated from per-session snapshots the daemon writes at every turn-end — **not** the provider's actual bill. Models with no catalog price surface in `unpricedTokens` rather than being fabricated as $0.

## CLI

```bash
agentproto models [adapter]          # catalog for one adapter
agentproto usage rollup --window 5h
```

## Gotchas

- `usage_rollup` is an estimate from local snapshots — it can diverge from the provider's bill (queued turns, retries, unpriced models). Say "estimate" when quoting numbers.
- Model identity is `vendor/product[@route]` — `z-ai/glm-5.2` and `z-ai/glm-5.2@openrouter` are different routes with potentially different prices.
- Auth profile credentials are never returned — only `keyStatus`, fingerprints, and last-4 digits. If a spawn fails auth, re-check `keyStatus` on `auth_profile_list` rather than trying to echo the secret.
- `harness_preset_create` rejects a `profileRef` that does not exist or is disabled, and a `defaultModel` the profile's allowlist cannot service.
- Curated allowlists (`mode: "allow"`) drift as catalogs change — `auth_profile_refresh_models` re-syncs against the current catalog on demand, nothing does it automatically.

## Pointers

- agentproto — daemon overview.
- ap-adapters — what each harness can reach; where its creds live.
- ap-spawn-agent — attach `access.profileRef` / `model` at spawn time.
- cheap-coders — routing to economic models through this machinery.
