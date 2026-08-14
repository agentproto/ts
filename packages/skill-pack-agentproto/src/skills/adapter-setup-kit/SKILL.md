---
name: adapter-setup-kit
description: >-
  Discover, configure, and expose agentproto's infrastructure building blocks
  via `@agentproto/adapter-kit`: catalog adapters (CLI agents, tunnels,
  browsers) with their supported/available/ready status, configure a provider
  that requires credentials (multi-field, stored plaintext-never-redisplayed),
  and open a public HTTPS tunnel (ephemeral Cloudflare quick or stable named)
  to expose the gateway or a local service to a remote agent. Trigger this
  skill when the user wants to "see which adapters/agents are installed",
  "configure cloudflare-named / a tunnel provider", "expose my local port /
  the daemon over HTTPS", "a stable public URL for a remote agent", or talk
  about `adapter_list` / `setup_tunnel_provider` / `tunnel_create`. Complements
  the orchestration skills (which ASSUME the adapter is ready) by covering
  the upstream: inventory + setup + network exposure.
---

# Adapter setup kit (catalog, setup, tunnels)

The upstream of orchestration: before you `agent_start`, you need an adapter
that is **ready**; to drive a remote agent or expose a service, you need a
**tunnel**. This skill covers inventory (`list_*`), setup of sensitive
providers (`setup_*`), and network exposure (`tunnel_create`). The other
orchestration skills assume all of this is already in place.

## The three adapter families

A single foundation (`@agentproto/adapter-kit`) catalogs three families, each
with its own `list_*`:

- **CLI agents** — `adapter_list` (claude-code, hermes, opencode, codex,
  openclaw…). What you spawn.
- **Tunnels** — `list_tunnel_adapters` (cloudflare-quick, cloudflare-named).
  How you expose.
- **Browsers** — `browser_adapter_list` (agents that drive a browser).

They all return a uniform 3-state **status**:

- **`supported`** = known but **not installed** (e.g. opencode, codex →
  `version: "not installed"`). You need to install the package
  (`@agentproto/adapter-<slug>`).
- **`available`** = installed but **setup not done** (e.g. cloudflare-named:
  `requiresAuth` → needs credentials).
- **`ready`** = installed **and** configured, usable right away (e.g.
  claude-code, hermes, cloudflare-quick).

**Golden rule: call `list_*` BEFORE spawning/opening.** Don't guess what's
installed — an `agent_start` on a `supported` (not installed) adapter fails.

## Pattern 1 — Cataloging (the upstream check)

`adapter_list` returns, for each agent: `slug`, `name`, `version`, `protocol`
(acp/…), `streaming`, `packageName`, `models` (the list of models the adapter
knows about), `status`, `hint`. Real-world example: `claude-code` and
`hermes` are `ready`; `opencode` / `codex` / `openclaw` are `supported`
(`version: "not installed"`). Use `models` to offer a model choice at spawn
time, and `status` to only offer the `ready` ones.

`list_tunnel_adapters` additionally returns a **`capabilities`** block per
provider: `stableUrl`, `autostart`, `customDomain`, `requiresAuth`, `hasApi`
— this is what decides which provider fits the need (stable URL? restart on
boot?).

## Pattern 2 — Configuring a sensitive provider (`setup_*`)

An `available` provider that requires creds is configured **without ever
exposing the secret**:

```
setup_tunnel_provider({ slug: "cloudflare-named",
  value: "{\"hostname\":\"app.example.com\",\"tunnelId\":\"<id>\",\"credentialsFile\":\"<path?>\"}" })
```

- `value` is a **JSON string** (multi-field) — the kit handles multi-field
  credentials via a single serialized string.
- **Sensitive by construction**: stored as `0600`, **never redisplayed** in a
  tool result or logged. Don't expect to read it back — if you need to
  verify, check the `available → ready` transition via
  `list_tunnel_adapters`, not the value itself.
- After a successful setup, the provider transitions `available → ready`.

(The same multi-field/sensitive `setup_*` pattern applies to the other
families that require creds — it's a primitive of the kit, not specific to
tunnels.)

## Pattern 3 — Exposing a port over public HTTPS (`tunnel_create`)

Two backends, chosen based on whether you want disposable or stable:

- **`quick`** (default, **zero credentials**): Cloudflare Quick Tunnel,
  ephemeral URL `*.trycloudflare.com` **regenerated on every run**. Perfect
  for a one-off test / a disposable webhook receiver.
  ```
  tunnel_create({ targetPort: 3000 })   // → https://xxxx.trycloudflare.com
  ```
- **`named`** (BYO, **stable**): a cloudflared tunnel you provisioned once
  (`cloudflared tunnel create` + `route dns`), tied to a **stable hostname
  that survives restarts**. Pass `hostname` + `tunnelId`, and
  `autostart: true` so the daemon restarts it on boot.

  ```
  tunnel_create({ targetPort: 8080, provider: "named",
    hostname: "app.example.com", tunnelId: "<id>", autostart: true })
  ```

- `targetHost` defaults to `127.0.0.1` (only set `localhost` if the target is
  IPv6). `tunnel_create` returns the `TunnelDescriptor` once cloudflared is
  ready (typically < 10 s).
- Tracking / lifecycle: `tunnel_list` (before opening a duplicate),
  `tunnel_status({ tunnelId })` (UUID id **or** the `name` slug given at
  create time), `tunnel_stop`.
- **`tunnel_create` does NOT gate auth** — pure passthrough, the proxied
  service handles its own authn. If you want an auth layer in front, that's
  `remote_enable` (≠ tunnel), not `tunnel_create`.

Orchestration use case: exposing the **agentproto gateway** (or a
sub-gateway) so a **remote** agent can connect to it, or exposing a local
**webhook receiver** to exercise the `notifyUrl` escalation (see
`durable-supervision`) — a `quick` tunnel is enough for the latter.

## Gotchas (real-world / from the actual surface)

- **Status ≠ binary**: `supported` means "I know this adapter", not "it's
  there". Check `version` (`"not installed"` = needs installing) before
  relying on it.
- **Quick tunnel = volatile URL**: a restarted `quick` gets a **new URL** →
  `autostart` only makes sense for `named`. For anything durable (a
  registered webhook, a remote agent), use `named`.
- **One-way secret**: `setup_*` never redisplays the value. Don't build a
  flow that assumes you can read it back; reason about the `ready` status
  instead.
- **`tunnel_status` accepts the name**: no need to remember the UUID if you
  passed a `name` to `tunnel_create`.
- **targetHost**: `127.0.0.1` by default; a service bound IPv6-only will
  only respond via `localhost` — otherwise the tunnel proxies into the void.

## Setup checklist

- [ ] `list_<family>` first → identify `ready` vs `available` vs `supported`
- [ ] Install the package if `supported` (`@agentproto/adapter-<slug>`)
- [ ] `setup_*` if `available` + `requiresAuth` (value = multi-field JSON,
      sensitive)
- [ ] Confirm the transition to `ready` via a `list_*` (not by reading back
      the secret)
- [ ] Tunnel: `quick` for disposable, `named` (+`autostart`) for stable
- [ ] `tunnel_list` before opening a duplicate; `tunnel_stop` at end of life
