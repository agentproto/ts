---
name: ap-adapters
description: Install and inspect agent CLI adapters (harnesses) on the agentproto daemon — adapter_list, adapter_install, harness_capabilities for credential/billing/tooling ground truth, role_list for spawn roles, plus the agentproto adapters CLI. Trigger when asked which agents are installed, to install claude-code or hermes, or to debug adapter credentials.
---

# ap-adapters

## When to use

- Before spawning: which adapters are actually installed and what each can do on this host.
- A spawn fails or bills oddly — is the credential there? Which providers can it reach?
- You need to install a new agent CLI (claude-code, hermes, aider, …) as an adapter.

## Inspect what is installed

```json
adapter_list({})
// → [{ "slug": "claude-code", "version": "0.1.0", "protocol": "acp", ... },
//    { "slug": "hermes", ... }]

role_list({})
// → spawn-time roles: 'executor' (leaf, cannot delegate), 'supervisor' (may spawn children)
```

`adapter_list` is the static manifest view. For what an adapter can actually **DO** here, ask `harness_capabilities`:

```json
harness_capabilities({ "adapter": "claude-code" })
// → { "authStores": [...],            // where creds live (env vars, keychain files)
//     "providers": [ { "id": "anthropic", "cred": { "present": true, ... } } ],
//     "models": { "mechanism": "free-form", "ids": [...] },
//     "application": { "modelApply": "config", "postureApply": "none" } }
```

`harness_capabilities` is ground truth — it complements the manifest with the live/parsed picture from each adapter's own native config/creds store. Omit `adapter` to get every installed one.

## Install

```json
adapter_install({ "slug": "claude-code" })
```

Ordinary install failures come back as `ok: false` in a normal result — read the message, don't assume success. A fresh install still needs credentials before it can bill: run `auth_discover_credentials` and `auth_profile_import` (see ap-models-auth).

## CLI equivalents

```bash
agentproto adapters list            # = adapter_list
agentproto adapters show <slug>
agentproto adapters install <slug>  # = adapter_install
agentproto adapters uninstall <slug>
agentproto adapters enable/disable <slug>
agentproto install <slug>           # shorthand install
agentproto setup <slug>             # interactive credential/config setup
agentproto run <slug>               # run the adapter directly
agentproto chat <adapter>           # interactive chat with a specific adapter
```

## Gotchas

- **hermes has NO built-in file/shell tools** — spawned bare, it can only chat. Pass `mcpServers: [{ "name": "agentproto", "transport": "http", "ref": "http://127.0.0.1:18790/mcp" }]` at spawn so it gets real tools (see ap-spawn-agent). `claude-code` / `claude-sdk` have built-in Read/Write/Edit/Bash tools and need no mounting.
- Install "failures" return `ok: false` as a normal result, not a thrown error — always read the result, never pattern-match on absence of an exception.
- The manifest blurb lies about capability; `harness_capabilities` is the source of truth for what works on this host (credential presence, billable providers, how model/posture choices are applied).
- Model/posture application differs per adapter: some switch live via session config, others report `requires-restart` — check `application` in the capabilities output before promising a live switch.
- `role_list` shows the lattice before spawning; spawning a role not in it is rejected.

## Pointers

- agentproto — daemon overview; adapters are the executors it drives.
- ap-spawn-agent — spawn sessions on these adapters.
- ap-models-auth — credentials, billing profiles, and model routing.
- agentproto — adapter bring-up and capability discovery in depth.
