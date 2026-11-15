# `agentproto accounts`

```text
agentproto accounts slots [--json]
agentproto accounts swap <family> [--move-alive] [--dry-run] [--json]
agentproto accounts prefer <slot> <profile> [--move-alive] [--dry-run] [--json]
agentproto accounts health [--clear <profile>] [--json]
```

Account slots: a named indirection between the accounts your code and presets
ask for and the real auth profiles that bill them, which can also be an
ordered list of accounts of accounts. `health` shows which accounts are exhausted and until
when. A thin wrapper over the daemon's `account_slots_list` /
`account_slots_swap` / `account_slots_prefer` and `account_health_list` /
`account_health_clear` MCP tools.

## Why this exists

A preset or an agent manifest that names a real account
(`profileRef: "claude-subs-agentik"`) has to be edited, and every session on it
restarted by hand, the day that subscription hits its limit. A slot moves that
choice to one place, `accountSlots` in `~/.agentproto/config.json`:

```json
"accountSlots": {
  "claude-primary":   "anthropic-sub-hodl",
  "claude-secondary": "claude-subs-agentik"
}
```

Anything that takes a `profileRef` (`agent_start.access`, session presets,
harness presets, `turnRetry.fallback`, `session_restart`, ...) also takes
`slot:<name>`, resolved to the real profile at the moment of use. Changing
subscription is then one swap, not a commit.

Slot names use letters, digits, `_` and `-` (no dot: config paths are dotted).
A slot must name a real profile, never another slot. An unknown slot, or one
pointing at a missing or disabled profile, is an explicit error when a spawn,
restart or fallback uses it; there is never a silent fallback to some other
account. Set one slot with:

```bash
agentproto config set accountSlots.claude-primary anthropic-sub-hodl
```

A session records the real profile it bills (`accessProfile`, unchanged for
billing and usage) and, beside it, the slot it asked for (`accessSlot`).

## Several accounts per slot

A slot can list several accounts, in order, instead of naming one:

```json
"accountSlots": {
  "opencode-go":    ["opencode-ws01", "opencode-developerws003", "opencode-hodl-ws01"],
  "claude-primary": "anthropic-sub-hodl"
}
```

`slot:opencode-go` resolves to the FIRST account of the slot that exists, is
enabled, may run the requested model (the profile's model allow-list) and is
not exhausted (see [`health`](#health)). A string is a slot with one account. A multi-account slot
holds real profiles only, never `slot:` refs, and lists each account once
(`agentproto config set` validates both forms).

- **Every account spent.** The spawn is refused with the typed error
  `account_slot_exhausted`, whose `details.retryAfter` is the nearest return
  time (so a caller can say "back on 21/11 at 05:00"). A spent account is never
  taken anyway.
- **A session that runs dry mid-way.** When a turn on an account of a multi-account slot ends in
  an account cap (a usage cap, or an empty wallet: `Insufficient balance`,
  402), the daemon marks the account exhausted, then restarts the session,
  with its context, on the next account of the same slot, same model. This is
  an implicit step BEFORE `turnRetry.fallback`: a preset no longer lists its
  backup accounts. The `fallback` list stays for the other axis (another model
  or harness), reached when no other account of the slot can serve. Needs the session to have a `turnRetry` policy (executor and
  box sessions have one by default). A rejected key (401/403) is not an
  exhausted account: it is a broken one, and the session is never moved to
  another account in silence.
- **Changing the order.** `accounts swap` stays, for the
  `<family>-primary` / `<family>-secondary` pair of single accounts (it refuses
  a multi-account slot). `accounts prefer` reorders a multi-account slot.

## `prefer <slot> <profile>`

```bash
agentproto accounts prefer opencode-go opencode-hodl-ws01 --dry-run
agentproto accounts prefer opencode-go opencode-hodl-ws01 --move-alive
```

Puts `<profile>` at the head of the slot `<slot>`; the others keep their order.
A profile outside the slot is added at the head.

| Flag | Purpose |
|------|---------|
| `--move-alive` | Also restart, with their context, the ALIVE sessions on the slot that bill another account, onto `slot:<slot>`. Dead sessions are never restarted. |
| `--dry-run` | Print the new order and the sessions that would move; write nothing. |
| `--json` | Emit the raw result (`before`, `after`, `moved`, `failed`). |

## `health`

```bash
agentproto accounts health
agentproto accounts health --json
agentproto accounts health --clear opencode-ws01
```

The daemon keeps a circuit breaker per REAL account in
`~/.agentproto/account-health.json` (never a slot): which accounts are empty,
and until when. `health` lists every account it knows (those with an entry plus
every account of a slot) with:

- `state`: `ok`; `exhausted` (closed until `until`: nothing is started on it,
  slots skip it); `probing` (`until` has passed: eligible again, the next real
  turn is the trial);
- `until` and `untilBasis`, in decreasing order of trust. `untilBasis` reuses
  the AIP-67 `basis` vocabulary, since it answers the same question (where this
  figure came from): `provider` (or `probe`, for an undocumented surface): a
  quota reader's `resetsAt`, Anthropic subscriptions; `observed`: the provider
  said when, in the error this host received (`resets in 1d 9h`,
  `resets 12pm (Europe/Paris)`, `retry after ...`); `estimated`: nothing was
  said, so a backoff by strike (30 min, 2 h, 6 h, then 24 h);
- the reason, the strike count, and for an Anthropic profile the last remaining
  quota a reader stored (no live probe is made, nothing is billed).

An account returns BY ITSELF once `until` has passed: nothing to unblock after a
renewal. A clean turn on it clears the entry; the same failure again on the
trial adds a strike and a longer backoff. `--clear <profile>` reopens one now,
for a recharge made before `until`. `daemon_health` carries the closed accounts
as `accountHealth`, next to `modelCooldowns`.

What closes an account: a turn classified `usage-limit` on it, which now
includes an empty wallet (HTTP 402, `payment required`, `insufficient balance /
credits / funds / quota`, `credit balance is too low`; they used to count as
`auth`). The free-tier per-IP cap (`Free usage limit reached`) is not a fact
about the account and never closes one. The real OpenCode Go messages seen on
2026-11-14: `Insufficient balance. Top up at https://opencode.ai/console/<org>/billing?credits=1.`
(empty wallet) and `OpenCode Go usage limit reached (weekly, resets in 1d 9h).`
(plan window, with its return time).

## `slots`

```bash
agentproto accounts slots
agentproto accounts slots --json
```

Lists each slot, the profile it points at (flagged when that profile is
missing or disabled), and the ALIVE sessions on it: `via: slot` when the
session asked for `slot:<name>`, `via: profile` when it names the slot's
profile literally. A multi-account slot shows each of its accounts in order with its health
(`exhausted until ...`), and the account a spawn lands on now.

## `swap <family>`

```bash
agentproto accounts swap claude --dry-run
agentproto accounts swap claude
agentproto accounts swap claude --move-alive
```

Exchanges `<family>-primary` and `<family>-secondary`. New spawns, restarts and
turnRetry fallbacks that name `slot:claude-primary` then land on the other
account.

| Flag | Purpose |
|------|---------|
| `--move-alive` | Also restart, with their context (new session id, cron targets re-armed), the ALIVE agent sessions billing the departing primary account, whether through the slot or by naming the profile literally, onto `slot:<family>-primary`. Dead sessions are never restarted. |
| `--dry-run` | Print the swap and the sessions that would move; write nothing. |
| `--json` | Emit the raw result (`before`, `after`, `moved`, `failed`). |

Without `--move-alive`, sessions already running keep their account until they
restart or their `turnRetry.fallback` fires. A preset whose fallback chain is
`[{ access: { profileRef: "slot:claude-primary" } }, { access: { profileRef: "slot:claude-secondary" } }]`
covers both cases: the fallback skips the account the session is already on,
so before a swap it moves to the secondary, and after a swap it moves to the
new primary.

Exit codes: `0` success, `1` no daemon / tool error / a session failed to move,
`2` missing family, slot or profile, or unknown subcommand.

## See also

- [`sessions.md`](./sessions.md) — `sessions switch-profile` moves sessions between two named profiles
- [`auth.md`](./auth.md) — `auth profile list` to find profile ids
- [`config.md`](./config.md): `config set accountSlots.<slot> <profile-id>` (or a JSON list for a multi-account slot)
- [`quota.md`](./quota.md): `quota status` reads a provider's remaining quota; a reading at 0 closes the account
