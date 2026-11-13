# `agentproto accounts`

```text
agentproto accounts slots [--json]
agentproto accounts swap <family> [--move-alive] [--dry-run] [--json]
```

Account slots: a named indirection between the accounts your code and presets
ask for and the real auth profiles that bill them. A thin wrapper over the
daemon's `account_slots_list` / `account_slots_swap` MCP tools.

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

## `slots`

```bash
agentproto accounts slots
agentproto accounts slots --json
```

Lists each slot, the profile it points at (flagged when that profile is
missing or disabled), and the ALIVE sessions on it: `via: slot` when the
session asked for `slot:<name>`, `via: profile` when it names the slot's
profile literally.

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
`2` missing family or unknown subcommand.

## See also

- [`sessions.md`](./sessions.md) — `sessions switch-profile` moves sessions between two named profiles
- [`auth.md`](./auth.md) — `auth profile list` to find profile ids
- [`config.md`](./config.md) — `config set accountSlots.<slot> <profile-id>`
