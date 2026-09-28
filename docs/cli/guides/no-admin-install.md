# No-admin install: `agentproto` on a locked-down Mac

A concrete walkthrough for the machine this guide assumes: a work-issued
macOS laptop with **no admin rights** (no `sudo`, no Homebrew, no writing to
`/usr/local`), on a corporate network that only allows outbound HTTPS/WSS
through an `HTTPS_PROXY`. Goal: run `agentproto serve` as a background
service under your own account, pair it with a home daemon, and share this
machine's local Ollama/LM Studio inference with that home daemon
(DEVICES-PLAN items 3–4) — no step here needs an admin.

Every command below was actually run (against a scratch `$HOME`, never the
real one) while writing this guide — see the callouts for what was verified
and how.

> This is the "how do I get onto this machine at all" guide. For what pairing
> itself guarantees, see [pairing.md](../concepts/pairing.md); for the
> inference-sharing commands referenced in step 4, see
> [`devices`](../verbs/devices.md#share-inference).

## 1. Node, entirely under `$HOME`

**Naive approach that needs admin:** a system-wide Node from an installer
`.pkg`, or Homebrew's `/opt/homebrew` (root-owned on Intel Macs at
`/usr/local`), both need write access outside your home directory.

**No-admin alternative: [nvm](https://github.com/nvm-sh/nvm).** Its installer
writes only under `~/.nvm` and appends a few lines to your shell profile
(`~/.zshrc`/`~/.bash_profile`) — nothing outside `$HOME`, no `sudo` anywhere
in the script:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# reload your shell, then:
nvm install --lts
nvm use --lts
node -v   # confirms you're on the nvm-managed node, not a system one
```

Once Node comes from nvm, `npm install -g <pkg>` also needs no `sudo`: nvm's
`node`/`npm` already live under `~/.nvm/versions/node/<version>`, and a
global install just writes into that same user-owned tree.

## 2. `agentproto` itself

```bash
npm install -g @agentproto/cli
agentproto --version
```

**If you're on a system Node instead of nvm** (can't switch it), `npm
install -g` will try to write to a root-owned prefix like `/usr/local/lib`
and fail without `sudo`. The no-admin fix is a user-owned npm prefix:

```bash
mkdir -p ~/.local
npm config set prefix ~/.local
export PATH="$HOME/.local/bin:$PATH"   # add to your shell profile too
npm install -g @agentproto/cli
```

Verified while writing this guide: `npm install --global --prefix
<scratch>/.local <pkg>` completes with exit 0 and puts everything under the
scratch prefix — no elevated permissions requested at any point.

## 3. The daemon as a user-level `launchd` agent

The real command (there is no separate "daemon install" name to guess at —
this is it): [`agentproto daemon install`](../verbs/daemon.md#install). It
writes a **user LaunchAgent**, not a system LaunchDaemon:

```bash
agentproto daemon install
```

This writes `~/Library/LaunchAgents/sh.agentproto.plist` and loads it with
`launchctl bootstrap gui/$(id -u) <plist>` — the **`gui/<uid>` domain**,
scoped to your own login session. That's the no-admin path by construction:
a system LaunchDaemon (`/Library/LaunchDaemons`, the `system` domain) needs
root; a user LaunchAgent under your own `$HOME` and the `gui/<uid>` domain
never does.

Verified while writing this guide: `HOME=<scratch> agentproto daemon install
--dry-run` (the dry-run just prints what it would do) exits 0, and the
printed plist path, log path, and `HOME` env entry are all under the scratch
`$HOME` — nothing reaches outside it, and the `launchctl bootstrap gui/$(id
-u) …` line it prints never touches the `system/` domain. Drop `--dry-run`
to actually write and load it.

Check it's up:

```bash
agentproto daemon status
```

## 4. The corporate proxy: `HTTPS_PROXY` / `NO_PROXY`

Two separate things need to see the proxy, and today only one of them does
automatically:

- **`agentproto` CLI invocations** (e.g. `pair offer`, `devices add`) run in
  your own shell, so exporting `HTTPS_PROXY`/`NO_PROXY` in your profile is
  enough — the CLI's rendezvous dial (`daemonDialRendezvous` /
  `pair-transport.ts`'s `dialRendezvous`) reads them itself.
- **The daemon**, once installed as a launchd job, does **not** inherit your
  shell's environment — launchd jobs start with a minimal environment of
  their own, set via the plist's `EnvironmentVariables` dict.

**Current limitation, called out honestly:** `agentproto daemon install`
today only bakes `PATH` and `HOME` into that dict (see `renderPlist` in
`packages/cli/src/commands/daemon.ts`) — there's no flag or config key yet
to thread `HTTPS_PROXY`/`NO_PROXY` through automatically. Until that lands,
the no-admin workaround is a one-time manual plist edit — still entirely
under `$HOME`, still no `sudo`:

```bash
# 1. Let `daemon install` write the plist once, as above.
# 2. Edit ~/Library/LaunchAgents/sh.agentproto.plist by hand and add your
#    proxy vars inside the existing <key>EnvironmentVariables</key> <dict>:
```

```xml
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>…</string>
    <key>HOME</key><string>…</string>
    <key>HTTPS_PROXY</key><string>http://proxy.corp.example:8080</string>
    <key>NO_PROXY</key><string>127.0.0.1,localhost</string>
  </dict>
```

```bash
# 3. Reload the job so launchd picks up the edited plist — `daemon restart`
#    is NOT enough here (`launchctl kickstart` restarts the PROGRAM, not the
#    job DEFINITION); bootout + bootstrap re-reads the file:
launchctl bootout gui/$(id -u)/sh.agentproto
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sh.agentproto.plist
agentproto daemon status
```

**Caveat to know about, not just a footnote:** `agentproto daemon
start`/`restart` self-heals a fresh `PATH` into the plist on every kickstart
(so a newly-installed CLI tool stays visible to the daemon) — but that
self-heal only ever *rewrites* the plist's `PATH` entry when `PATH` itself
changed, and when it does rewrite, it regenerates the whole
`EnvironmentVariables` dict from scratch (`PATH` + `HOME` only), which drops
your hand-added `HTTPS_PROXY`/`NO_PROXY` again. If that happens, redo step 2.
Re-running `agentproto daemon install` also regenerates the plist and drops
the manual edit the same way — reapply it afterward.

With `HTTPS_PROXY` reaching the daemon's own environment, its rendezvous
dial routes through the proxy automatically (see
[`proxy-dial.ts`](../../../packages/cli/src/util/proxy-dial.ts) — no further
config needed). `agentproto doctor` reports which mode it's actually using:
a "Rendezvous" check with detail `reachable (direct)` or `reachable (via
proxy)`.

## 5. Pair the two machines and share inference

On B (this locked-down machine, once steps 1–4 are done):

```bash
agentproto pair offer --host
```

`--host` mints a **host-scoped** offer — the only kind that lets the far
side register B as a driveable host rather than an ordinary remote-control
peer (see [pair.md](../verbs/pair.md#offer--daemon-side)). Then opt B in to
exposing its local inference:

```bash
agentproto devices share-inference on
```

(Needs `features.llmEndpoint` on too, and a restart to take effect — see
[`devices.md#share-inference`](../verbs/devices.md#share-inference) for both
gates.)

On A (your home daemon):

```bash
agentproto devices add <the offer-url from B>
```

Once both are up, A addresses B's local models transparently, e.g.
`ollama@my-work-mac/llama3.1:8b` in any model string routed through A's own
`llm-endpoint` gateway.

## Summary: what needs admin, and what doesn't

| Step | No-admin form | What WOULD need admin |
| --- | --- | --- |
| Node | nvm under `~/.nvm` | A system installer `.pkg`, or Homebrew's root-owned prefix |
| `agentproto` CLI | `npm install -g` on nvm's node, or `--prefix ~/.local` on a system node | `npm install -g` on a system node with no prefix override |
| Background service | `agentproto daemon install` — user LaunchAgent, `gui/$(id -u)` domain | A LaunchDaemon under `/Library/LaunchDaemons` (`system` domain) |
| Proxy env for the daemon | Manual `EnvironmentVariables` edit in `~/Library/LaunchAgents/sh.agentproto.plist` + `launchctl bootout`/`bootstrap` (still `gui/$(id -u)`) | N/A — this path was never admin-gated, just not yet automated |
