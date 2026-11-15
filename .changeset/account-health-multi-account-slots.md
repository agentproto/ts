---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Account health and multi-account slots.

`@agentproto/runtime`:

- Persistent per-account circuit breaker in `~/.agentproto/account-health.json` (new `account-health.ts`: `markAccountExhausted`, `accountHealthOf`, `listAccountHealth`, `clearAccountHealth`, `parseExhaustionUntil`, `createAccountHealthStore`). A turn that ends in a usage cap closes the billed profile until the provider's own reset time (`resets in 1d 9h`, `resets 12pm (Europe/Paris)`, retry-after), a quota reader's `resetsAt`, or a 30 min / 2 h / 6 h / 24 h strike backoff; `until` passing reopens it (state `probing`), a clean turn clears it. Anthropic quota readers close an account at 0 percent. The free-tier per-IP cap never closes an account.
- An empty wallet is a usage cap: 402, `payment required`, `insufficient balance / credits / funds / quota` and `credit balance is too low` now classify as `usage-limit` instead of `auth` (401, 403 and a rejected key stay `auth`). The real OpenCode Go message `Insufficient balance. Top up at ...` is pinned. A wallet or plan-window message no longer cools a model daemon-wide or an egress address. `turnRetry.on` / `rotateOn` also accept the AIP-46 name `quota-exhausted` as an alias of `usage-limit`.
- `accountSlots.<name>` accepts an ordered list of profile ids besides one id. `slot:<name>` resolves to the first account that is enabled, may run the model and is not exhausted; every account spent is the typed `account_slot_exhausted` (`details.retryAfter`). A session that runs dry on an account of such a slot is restarted with context on the next account, same model, before `rotate` and `turnRetry.fallback`.
- MCP: `account_health_list`, `account_health_clear`, `account_slots_prefer`; `account_slots_list` shows each account's health on a multi-account slot; `daemon_health` carries `accountHealth`. `agent_start` can fail with `account_slot_exhausted`.

`@agentproto/cli`: `agentproto accounts health [--clear <profile>]` and `agentproto accounts prefer <slot> <profile> [--move-alive] [--dry-run]`; `accounts slots` prints a multi-account slot with each account's health.
