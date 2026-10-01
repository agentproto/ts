# Device fleet: one controller, many paired hosts

A **device fleet** is a star, not a mesh: one controller daemon holds the
device registry ([`agentproto devices`](../verbs/devices.md)) and dials each
host over the same end-to-end rendezvous channel that pairing uses — the
broker is blind to everything but ciphertext (see
[Pairing](../concepts/pairing.md#threat-model)). The controller can do three
fundamentally different things with a host, and conflating them is the most
common way to end up confused about why a spawn or a model call "doesn't
work":

1. **Remote control** — read and drive the host's existing sessions.
2. **Spawn target** — run *new* agent sessions on the host's machine, as if
   it were a cloud box.
3. **Inference source** — consume the host's *local* models (LM Studio,
   ollama, …) from a session that runs anywhere.

This page is the end-to-end conceptual guide: the capability model, the
bring-up recipe, addressing, a failure taxonomy from live cross-device
dogfood, and fleet hygiene. For the verbs themselves see
[`devices`](../verbs/devices.md); for the crypto and threat model see
[Pairing](pairing.md).

## The three capabilities and their gates

All three ride the SAME E2E channel, but each has a distinct gate — and the
gates are not the same:

| Capability | Gate (on the HOST) | What the controller gets |
| --- | --- | --- |
| Remote control | plain pairing (`pair offer` + `pair accept`, or `devices add`) | `devices sessions` / `devices prompt` — read and write the host's sessions |
| Spawn target | `pair offer --host` + `devices add` + **`allow-spawn on`** + restart | `agent_start({ sandbox: "device:<fp>" })` — spawn/proxy sessions ON the host |
| Inference source | same host-scoped pairing + **`share-inference on`** + restart | `agent_start({ inference: { model: "<model>@<device>" } })` — the host's local models |

Two rules fall out of this table:

- **Host-scoped pairing is mandatory for the second and third rows.** A plain
  remote-control pairing never gets spawn or inference routes, whatever the
  feature flags say — `devices add` refuses a non-host-scoped offer outright
  (see [Offer scope (reverse pairing)](pairing.md#offer-scope-reverse-pairing)).
- **`share-inference` has a direction: it makes THE MACHINE RUNNING IT share
  its models.** Run it on the Windows host to share Windows' LM Studio; run it
  on the Mac Studio and you only share the Studio's inference. There is no
  "consume from X" flag — consumption is expressed by the *address*
  (`<model>@<device>`), sharing by the flag.

### Feature flags are read only at daemon boot

`allow-spawn` and `share-inference` write `features.deviceSpawnAllow` /
`features.deviceInferenceShare` to the host's `config.json`, and the running
daemon reads them **once, at boot**. Toggling the flag and re-spawning without
restarting silently keeps the feature OFF — the failure is quiet: the error
says "not opted in" even though you just opted in.

> **Toggle → restart `agentproto serve` → THEN test.** Check the pid/uptime
> to confirm the daemon actually died and respawned.

## Bring-up recipe

What finally worked, in order (CLI 1.8.0, field-verified 2026-10-01):

1. **Host:** `agentproto serve` running (current CLI, rendezvous reachable —
   the hosted broker `wss://rdv.agentproto.sh/v1` works out of the box).
2. **Host:** `agentproto pair offer --host` — NOT plain `pair offer`. A plain
   pairing never gets spawn/inference routes, and `devices add` fails with 400
   later.
3. **Controller:** `agentproto devices add <offer-url> --name <label>`.
   `handshake timed out` here = stale offer (>10 min TTL), daemon not
   connected, version mismatch, or blocked wss egress. Fix those and mint a
   FRESH offer.
4. **Host:** `agentproto devices allow-spawn on` → **restart the daemon**
   (see the boot-only flag warning above).
5. **Controller:** `agent_start({ sandbox: "device:<fp>", cwd: "<abs path on
   host>" })` — `cwd` is required, see
   [Addressing](#addressing).
6. **For local models:** LM Studio `lms server start` on the host, the `pi`
   adapter installed, then `agent_start({ adapter: "pi", model:
   "lmstudio/<publisher>/<id>", sandbox: "device:<fp>", cwd: ... })`.

The first end-to-end validation per host is always the same cheap probe:
**write a file, read it back, reply DONE.** It proves spawn + prompt + model +
tools + fs in one move.

## Addressing

| You want | Write | Notes |
| --- | --- | --- |
| Spawn on a host | `sandbox: "device:<fp>"` | `<fp>` is the host's fingerprint from `devices list`; the session is proxied — the adapter process runs on the host. |
| A working directory | `cwd: "<abs path>"` | **Required** on device spawns — see below. |
| The host's local models | `model: "<model>@<device>"` | e.g. `ollama@my-host/llama3.1:8b`; the controller's llm-endpoint gateway forwards to the host's endpoint over the paired channel — no inbound port on the host. |
| Drive a host session | `device_prompt` / `agent_output` with controller-side ids | See the dual-id note below. |

**`cwd` is required — the repo-identity guard fires only on a MISSING
`cwd`/`workspaceSlug`.** Before the guard existed, a device spawn with no
`cwd` silently landed on the host's active workspace (e.g.
`C:\Users\jerem`). Today that spawn fails with
`device_spawn_requires_repo_identity` (issue #1647). An explicit `cwd`
*outside* the paired repo spawns fine — the guard only saves you from
forgetting `cwd` entirely, so always pass one.

**Controller-id vs host-session-id (the P7 duality).** A session spawned over
the device bridge exists twice: once in the controller's registry (the id
`agent_start` returned) and once on the host (its own session id). The
controller-side id is the one that works in `device_prompt` and
`agent_output` — reads through those paths mirror the host's transcript live
over the E2E channel. The host-side id is what `devices sessions <fp>` shows
on the host itself.

## Failure taxonomy

Observed live on a Mac Studio controller driving Windows 11 + Mac Pro hosts
(CLI 1.7.1 → 1.8.0). Symptom → cause → fix:

| # | Symptom | Cause | Fix |
| --- | --- | --- | --- |
| F1 | `handshake timed out` / `transport closed` / `Request timed out` / `device_unreachable` on spawn — can repeat 7+ times in ~10 min | Broker relay flap: each dial is fresh per-exchange; the spawn may even have LANDED host-side despite the controller seeing a timeout | Before retrying a timed-out spawn, check `devices sessions <fp>` — else you double-spawn. 1.8.0 auto-retries once (~2s back-off) and on final failure returns a 400 naming the fingerprint, attempts, and `agentproto devices status <fp>` |
| F2 | Session created on the host but the prompt never arrives — "sessions appear but never get talked to" | `agent_start` over the device bridge is TWO dials (the MCP call, then the prompt POST); the second `forwardHttpStream` dial fails at ~15s when the channel is unhappy. Survives controller restarts and host reboots; plain `forwardHttp` reads keep working | Workaround: let `agent_start` land, then drive the session via `device_prompt` (the `forwardHttp` path). Unfixed — candidate next fix is a single-dial spawn (prompt inside the `agent_start` call) or bridge-level prompt retry |
| F3 | Prompts stop arriving on ALL hosts, but reads still work | Controller-side `forwardHttpStream` handshake wedge after several spawn/kill cycles (looks like a stream leak after session kills; host restarts do NOT clear it) | Restart the CONTROLLER daemon |
| F4 | Adapters vanish after a node switch; sessions exit before first turn ("pi exited", `adapter_not_found` everywhere) | Adapter packages resolve relative to the CLI's own install (`createRequire(import.meta.url)`); switching nvm nodes orphans globals installed under the old node | Reinstall adapters with the SAME node binary that runs the daemon (`~/.nvm/versions/node/vX/bin/npm i -g @agentproto/adapter-pi …`), confirm with `agentproto adapters`, restart. (Single-system-node Windows never hit this) |
| F5 | pi session completes its first turn with NO output and no error (pre-1.8.0) | Invalid LM Studio model id — the adapter's real "model not found" line sits only in the host's ring buffer | 1.8.0 stamps `firstTurnFailed: true` and surfaces the raw host warning. Pre-1.8.0 hosts still fail silently — upgrade before debugging model ids |
| F6 | Every npm-shim adapter (bin `npx`) dies with `spawn EINVAL` on device spawns — Windows only | Node ≥18.20.2 refuses to spawn `.cmd`/`.bat` shims without `shell:true` (CVE-2024-27980) | Fixed pre-1.8.0 (`win32-spawn.ts` rewrites shims to the real node entry, `npx.cmd → node …/npm/bin/npx-cli.js`, with a `shell:true` fallback). Historical — this is why early Windows spawns died while identical macOS spawns worked |
| F7 | `device_spawn_requires_repo_identity` on a device spawn | The P8 guard fires on a MISSING `cwd`/`workspaceSlug` — previously the spawn silently landed on the host's active workspace | Always pass an explicit `cwd` on device spawns. An explicit `cwd` outside the paired repo spawns fine; the guard only catches the forgotten-`cwd` case |
| F8 | "could not be resolved … install it" for a slug like `opencode-go/...` | `opencode-go/...` is a MODEL route, not an adapter | #1651 added the actionable hint: use `agent: '<installed-adapter>'` with `model: 'opencode-go/<id>'` and `route: { gateway: 'opencode-go' }`. Remaining gap: a genuinely unknown adapter name still gets the generic message, which does not list installed adapters |
| F9 | New controller-side fixes keep reproducing OLD bugs during validation | Controller version lag — the spawn/UX fixes live in the controller's runtime; hosts on 1.8.0 with a stale controller made the fixes impossible to validate | Upgrade controller AND hosts together — the controller is part of the fleet, not a bystander. After rebuilding the CLI from source, restart the daemon to pick up the new dist (build sha is printed in `daemon_health`) |
| F10 | Sessions die mid-validation; resumed executors need re-prompting (~2-5 min per cycle) | Restarting ANY daemon kills its sessions; `resumeSessionsOnBoot` revives the originals but a mid-turn executor gets truncated | Sequencing rule for fleet work: finish/kill executors FIRST, then restart |
| F11 | `npm i -g @agentproto/cli@1.8.0` on Windows resolves against a corporate Nexus that lacks the version | Corporate npm registry shadow | Install with an explicit `--registry=https://registry.npmjs.org/` |
| F12 | `lmstudio/ternary-bonsai-2-27b` passes the LM Studio catalog but fails to load; a bare `ternary-bonsai-2-27b` fails even in LM Studio itself | Wrong model-id format | Working form is `lmstudio/<publisher>/<model>` (e.g. `lmstudio/prism-ml/bonsai-27b`). Check the exact slug in LM Studio's server log / model list first |

## Fleet hygiene

- **Upgrade the controller AND the hosts together** (F9). The controller is
  part of the fleet: its runtime carries every spawn/UX fix, and a stale
  controller silently negates host upgrades. Same minor version across the
  fleet is the rule of thumb.
- **Adapters live with the node that runs the daemon** (F4). Global adapter
  packages are resolved relative to the CLI's own install, so an nvm/node
  switch orphans them. Reinstall under the daemon's node binary after any
  node change.
- **Restarts kill sessions** (F10). Finish or kill executors before
  restarting any daemon in the fleet; budget re-prompting time for resumed
  sessions.
- **Corporate registries shadow npm** (F11). On managed Windows hosts, pass
  `--registry=https://registry.npmjs.org/` explicitly when installing the CLI
  or adapters.

## Security recap

- **The broker is blind.** Every hop is the same E2E rendezvous channel: the
  broker splices two sockets and relays ciphertext byte-for-byte — it learns
  route tokens, IPs, timing, and sizes, never content, and cannot inject or
  alter frames (see the [Pairing threat model](pairing.md#threat-model)).
- **Host-scoped pairing is required for fleet control.** Spawn and inference
  routes exist only over a `pair offer --host` / `devices add` registration;
  a plain remote-control pairing never gets them, and `devices add` refuses a
  non-host-scoped offer (see
  [Offer scope (reverse pairing)](pairing.md#offer-scope-reverse-pairing)).
- **`allow-spawn` defaults off.** A host must explicitly opt in
  (`agentproto devices allow-spawn on` + restart) before any controller can
  spawn sessions on it — pairing alone is not consent to be a spawn target.

## See also

- [`devices`](../verbs/devices.md) — the verb reference: `add`, `status`,
  `allow-spawn`, `share-inference`, `sessions`, `prompt`, `join-token`.
- [`pair`](../verbs/pair.md#offer--daemon-side) — `offer --host` and the
  daemon-side ceremony.
- [Pairing](pairing.md) — the crypto, broker, and threat model underneath
  every hop in this page.
- [No-admin install](../guides/no-admin-install.md) — host-scoped pairing and
  inference sharing from a locked-down machine behind a corporate proxy.
