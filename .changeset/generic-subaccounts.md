---
"@agentproto/auth": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/adapter-opencode": minor
"@agentproto/driver-agent-cli": patch
---

Generalize opencode console workspaces into provider-agnostic sub-accounts. An auth profile can pin `subaccount: { kind, id, name? }` (an org / workspace / project of its account); a registry in `@agentproto/auth` (`registerSubaccountProvider`, `SubaccountProvider` with `list(account)` / `resolve(profile)`) applies the pin at spawn, so the runtime and auth packages no longer name any vendor. The opencode console implementation moved from `@agentproto/runtime` to `@agentproto/adapter-opencode` and is registered by the CLI at start-up. New `agentproto auth subaccounts list <profile|account> [--create [--prefix]]` and `auth profile create --subaccount <kind>:<id>`; `auth profile opencode-orgs` stays as a deprecated alias and legacy `source: "opencode-console:<orgId>"` profiles are migrated on read. Usage-limit failures name the profile and sub-account. `@agentproto/runtime` drops its `./opencode-console-source` export; `@agentproto/driver-agent-cli` honours `isolateDataHome: false` from a provider.
