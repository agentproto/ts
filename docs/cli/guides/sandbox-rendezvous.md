# Sandboxes and rendezvous: boot-and-drive vs. attach

A **sandbox** is a cloud box the agentproto daemon can run an agent session
on instead of the local machine — provisioned through a pluggable
`SandboxProvider`. This guide covers the full lifecycle: what a sandbox is,
the two ways to connect to one, how to keep one reachable long-term without
surprising your bill, and a worked example end to end.

> For the CLI verb reference, see [`verbs/sandbox.md`](../verbs/sandbox.md)
> (`agentproto sandbox attach`). This guide is the "why" and "how it fits
> together"; that page is the flag-by-flag reference.

---

## 1. What sandboxes are

Providers are resolved from a small built-in catalog by slug:

| Slug | What it runs | Package |
|------|---------------|---------|
| `local` | A real agentproto daemon in a fresh temp workspace on `127.0.0.1` — no cloud credentials needed. | built-in |
| `box` | An ascii.dev [Box](https://ascii.dev) cloud computer, behind an always-on systemd unit. | `@agentproto/sandbox-box` |
| `e2b` | An e2b Firecracker microVM (`agentproto-workstation` template). | `@agentproto/sandbox-e2b` |

(`modal` and `daytona` are catalog placeholders — AIP-36 day-1 provider ids
with no published package yet.)

Discover what's configured with the `list_sandbox_providers` MCP tool — it
reports each provider's status (`supported` / `available` / `ready`),
resolved package version, and declared capabilities (`networkEgress`,
`mounts`, `lifecyclePause`, `readOnly`) without ever returning credentials.

Configure a provider that needs credentials with `setup_sandbox_provider`
(e.g. `{ provider: "box", apiKey: "..." }`). That writes the key to
`~/.agentproto/sandbox-creds/<slug>.json` (mode 0600) and is what flips
`list_sandbox_providers`' status to `ready`.

**That stored credential is not the whole story.** Both the `box` and `e2b`
providers read their API key straight from **this process's own
environment** (`process.env.BOX_API_KEY`, `process.env.E2B_API_KEY`) when
they actually call the provider's API — the creds-store value only gates
readiness in `list_sandbox_providers`/`setup_sandbox_provider`. So whichever
process is doing the boot or the attach — the daemon for `agent_start`, or
your shell for `agentproto sandbox attach` — needs the provider's API key
set in *its own* environment too, not just registered via
`setup_sandbox_provider`.

## 2. Two models

There are two distinct ways a session or client ends up talking to a
sandbox's daemon, and they are not interchangeable.

### Boot-and-drive — `agent_start` with a `sandbox` spec

`agent_start` (MCP/HTTP only today — no `sessions start` CLI flag yet)
accepts a `sandbox` field: a provider slug (`"box"`, `"e2b"`) or an inline
AIP-36 spec. The daemon:

1. boots a **fresh** box (or reconnects to one via `reuse: "<sandboxId>"`),
2. spawns its own agentproto daemon *on* that box,
3. spawns the requested adapter there,
4. proxies the conversation back onto this session — `agent_prompt` /
   `agent_output` / `agent_kill` behave exactly as for a local spawn, and
   the transcript stays readable here even after the box is torn down.

The daemon **owns the box's lifecycle**: by default, closing a
`reuse`-eligible session *pauses* the box (not kills it) so it's reusable
later; set `lifecycle.destroy_on` if you want it destroyed instead. This is
the right model when an agentproto session is going to *drive* the box for
one conversation.

### Attach / rendezvous — `agentproto sandbox attach <provider> <id>`

```bash
agentproto sandbox attach <provider> <sandboxId> [--config-json <json>] [--json]
```

This is a completely different primitive: connect to a box that **already
exists** — booted by a prior `agent_start`, by the ascii.dev/e2b dashboard,
or by anything else — without tearing it down or taking it over. It's a
pure local shell over `@agentproto/runtime`'s `attachSandbox` — **no daemon
required on this machine**, since the whole point is reaching a *remote*
box's daemon, not this one's.

`attach`:

- resolves the provider and resumes the box (never boots a fresh one),
- ensures the box's own agentproto daemon is healthy,
- asks the provider to expose it **privately** (token-gated), and
- hands back a durable connection descriptor —
  `{ provider, sandboxId, mcpUrl, token, allowOrigin }` — plus a
  paste-ready `.mcp.json` snippet.

It **never calls `stop()`/`pause()`** on the box — attach leaves it exactly
as it found it, running and addressable. And it **fails closed**: if the
provider can't hand back a token-gated URL, attach errors out
(`sandbox_attach_ungated`) instead of ever printing an unauthenticated
persistent URL. A persistent address handed to a caller that may be an
entirely different process (a laptop, a CI job, another sandbox) has to be
gated by construction — there's no "trust the network" fallback here.

There's an MCP-callable twin of the same operation, `sandbox_attach`, for
callers that want this from inside another agent session rather than a
shell.

| | Boot-and-drive (`agent_start.sandbox`) | Attach (`sandbox attach`) |
|---|---|---|
| Box lifecycle | Daemon boots it, owns it, may pause/destroy on close | Untouched — never stopped or paused |
| Requires | The daemon's own `agent_start` call | Nothing local but provider creds — no daemon needed |
| Use when | You want an agentproto session to *drive* the box | You want to *reach* a box that's already running |
| Output | A session you `agent_prompt`/`agent_output` like any other | A durable `{mcpUrl, token}` any MCP client can dial into |

## 3. Connection matrix

| | Who initiates | What you get |
|---|---|---|
| **Server-in** (boot-and-drive) | The daemon boots the box and connects *into* it | A session; the box's endpoint is never exposed to you directly |
| **Client-reach** (attach) | You (or a CI job, or another sandbox) connect *out* to an already-running box | A standing `{mcpUrl, token}` any MCP client can dial |

If you already have shell or tunnel access to the box and would rather not
add another daemon-fronted HTTP exposure at all, there are lower-level
alternatives:

- **SSH local port-forward** — reach a port inside the box over your
  existing shell access instead of through `sandbox attach`'s own exposure
  step (`ssh -L <local-port>:localhost:<remote-port> ...`, or, if you're on
  Box, its own equivalent, `box forward <id> --remote <port> [--local
  <port>]`).
- **A named Cloudflare tunnel you control** — `agentproto tunnel create
  --provider cloudflare-named --hostname <host> --tunnel-id <id>` binds a
  stable hostname you provisioned yourself, instead of relying on the
  provider's own hosted URL (`https://<subdomain>-<port>.on.ascii.dev`) or
  `sandbox attach`'s token-gated exposure. See
  [`verbs/tunnel.md`](../verbs/tunnel.md) for the one-time named-tunnel
  setup.

Both are genuinely useful when you already have the access and just want a
plain TCP path — `sandbox attach` earns its keep when you want a
credentialed, paste-into-`.mcp.json` connection descriptor instead of
wiring the tunnel yourself.

## 4. Operational reality: running = billed, stopped = offline

This is the part that actually matters once a box sticks around past one
conversation.

**A stopped box is a snapshot, not a server.** Its hosted URL
(`https://<subdomain>-<port>.on.ascii.dev` for Box) only serves while the
box is *running*. `box stop` snapshots the filesystem and **pauses
billing** until you resume it — so a box you want reachable 24/7 has to
stay running, continuously.

One naming gotcha worth knowing before you reach for these: agentproto's
own `BootedSandbox.pause()` maps to Box's `stop` (snapshot, resumable,
billing paused) — while `BootedSandbox.stop()` maps to Box's `remove`
(actual deletion). Box's own CLI naming is the *reverse* of agentproto's
lifecycle verbs.

**Cost model.** Box bills per running second. At the time of writing:
roughly **$1 ≈ 100,000 box-seconds ≈ 27.8 hours**, so an always-on box
costs on the order of **$26/month**. This is illustrative, not a quote —
check `box limits` (or the ascii.dev dashboard) for your account's actual
rate, credit balance, and plan. `box limits` also reports `maxActiveBoxes`,
the concurrent-box cap for your plan — running one always-on box plus a
handful of on-demand ones is well within any tier, but it's the number to
check before scripting anything that boots boxes in bulk.

**Keeping a box awake.**

- `box new --no-auto-stop` at creation — disables auto-stop entirely
  (`ttlSeconds: null`). This is actually **agentproto's own default** when
  it boots a Box via `agent_start.sandbox`: unlike ascii.dev's own `box`
  CLI (1-hour default TTL), an agentproto-booted box starts sticky unless
  you pass an explicit `ttlSeconds` in the sandbox config. No-auto-stop is
  **sticky across `box resume`/`box stop`** cycles too — once set, it stays
  set.
- `box extend <id> --hours <n>` or `box extend <id> --ttl <seconds>` —
  pushes out an *existing* box's auto-stop deadline without going fully
  sticky. The numeric TTL caps out at `2592000` seconds (30 days).
  `box extend <id> --no-auto-stop` converts an existing box to sticky the
  same way `box new --no-auto-stop` does at creation.

**The tradeoff.**

- **Resume-on-attach (default, recommended)** — leave the box with a
  bounded TTL (or explicitly `box stop` it between uses) so it actually
  goes to sleep and billing pauses. `agentproto sandbox attach` resumes it
  in seconds when you need it. Cheap, but it isn't passively reachable —
  nothing can dial in until something attaches (which resumes it).
- **Always-on** — `--no-auto-stop` (or just don't override agentproto's own
  sticky default) plus `agentproto sandbox attach --keep-alive` keeps the
  box, and your attachment to it, alive indefinitely. Reachable 24/7, but
  billed continuously the whole time.

  > `--keep-alive` is landing as a companion flag to `sandbox attach` for
  > exactly this case — a heartbeat that keeps a long-lived external client's
  > attachment from going stale. If it's not in your installed CLI version
  > yet, `attach` still resumes and exposes the box; you'd just re-run it
  > periodically instead of relying on a background heartbeat.

Default to resume-on-attach unless you genuinely need a 24/7-reachable
endpoint (a webhook target, a standing CI runner, a demo box) — that's the
case where always-on's continuous billing is actually buying you something.

## 5. Worked example

Configure credentials once, then attach whenever you need to reach the box:

```bash
# 1. Register the Box provider's credentials (writes
#    ~/.agentproto/sandbox-creds/box.json — this only gates readiness).
#    Via the setup_sandbox_provider MCP tool:
#      { "provider": "box", "apiKey": "<your ascii.dev Box API key>" }

# 2. The provider's API key must ALSO be in the shell's own env — both the
#    daemon (for agent_start) and this shell (for `sandbox attach`) read it
#    directly, not from the creds store:
export BOX_API_KEY=bx_key_...

# 3. Boot a box via agent_start (MCP), or note the id of one you already
#    have — either way you need its sandboxId, e.g. bx_abc123.

# 4. Attach to it from anywhere with BOX_API_KEY set — your laptop, a
#    GitHub Action, or another sandbox:
agentproto sandbox attach box bx_abc123
```

```text
sandbox attached  provider=box  sandboxId=bx_abc123
  mcpUrl      https://frazil-pneuma-rallye-18790.on.ascii.dev/mcp
  token       •••••••• (gated)
  allowOrigin https://frazil-pneuma-rallye-18790.on.ascii.dev

Paste into .mcp.json:
{
  "mcpServers": {
    "sandbox-box-bx_abc123": {
      "type": "http",
      "url": "https://frazil-pneuma-rallye-18790.on.ascii.dev/mcp",
      "headers": { "Authorization": "Bearer ••••••••" }
    }
  }
}
```

Paste that `.mcp.json` block into a local Claude Code project (or a GitHub
Actions secret, or another sandbox's own `.mcp.json`) and it can reach the
box's daemon directly — no agentproto daemon of its own required.

If this needs to stay reachable indefinitely rather than just for this
session, make sure the box is sticky (`box extend bx_abc123 --no-auto-stop`,
or rely on agentproto's own no-auto-stop default from boot) and reach for
`agentproto sandbox attach box bx_abc123 --keep-alive` once that flag ships
in your CLI version, so the attachment itself doesn't go stale either.

## See also

- [`verbs/sandbox.md`](../verbs/sandbox.md) — `sandbox attach` flag reference
- [`verbs/sessions.md`](../verbs/sessions.md) — the `sandbox` field on
  `agent_start` (boot-and-drive)
- [`verbs/tunnel.md`](../verbs/tunnel.md) — named Cloudflare tunnels as a
  non-daemon-fronted exposure alternative
- [ascii.dev Box docs — long-running tasks](https://docs.ascii.dev/box/long-running-tasks)
  and [billing](https://docs.ascii.dev/box/billing) — authoritative source
  for current TTL/billing behavior
