# Keep Codex working in VS Code and Cursor after the OpenAI cutoff

On August 28, 2026, OpenAI told Cursor it's ending Cursor's access to
OpenAI's models. SpaceX closed its acquisition of Cursor's maker, Anysphere,
on August 14; OpenAI is invoking a change-of-control clause in its
agreement rather than pointing at any existing breach. The proposed cutoff
date is November 12, 2026, though OpenAI itself frames it as a transition
deadline, not a locked-in one.

Cursor's own numbers make the practical blast radius look small — co-founder
Michael Truell has said OpenAI models account for roughly 5% of Cursor's
traffic, with most users already on Claude or Gemini. But if you're in that
5%, "small for the userbase" doesn't help you. Grok, Composer, Claude, and
Gemini stay reachable in Cursor. GPT and Codex go.

It gets worse before it gets better: the official Codex extension
(`openai.chatgpt`) has been broken in Cursor 3.15 and 3.16 independently of
any of this. A Cursor team member confirmed it's not a bug — Cursor's
Secondary Side Bar is now reserved for Cursor's own agent UI, and the Codex
extension's attempt to dock there fails silently. The workaround (drag the
Codex view to the Activity Bar, or use `Codex: New Codex Agent` +
`View: Split Editor Right`) works, but it's one more thing standing between
you and just using the model you want.

This guide covers one path around both problems: running Codex through the
[agentproto](https://agentproto.sh) VS Code extension instead of OpenAI's
own one. It's not the only migration path — OpenAI's own suggestions (your
own API key, the standalone Codex IDE extension, a gateway) are simpler if
Codex is the only thing you need. This one is worth the extra setup if you
want Codex, Claude Code, and Gemini side by side in the same panel, or if
you want sessions that survive an IDE restart and are reachable from a CLI
or phone too — because they're not running inside the IDE process, they're
running on a daemon the IDE just talks to.

## What's actually true here, and what I verified

Everything below that describes the VS Code extension's UI and the
`agentproto` CLI setup sequence is read directly from the extension's
source (`packages/vscode/src/commands/spawn.ts`) and its published `README`
— this is what the extension does today, not a design intent. The Codex CLI
and its ACP wrapper are confirmed working on my machine, run directly from
a shell:

```
$ codex --version
codex-cli 0.150.1

$ npx -y @agentclientprotocol/codex-acp@1.1.14 --help
# installs and starts cleanly, no errors
```

What I could **not** verify live: spawning a codex session through my own
agentproto *daemon* specifically. My daemon process was started with a PATH
that doesn't include `npx` (see Troubleshooting below) — a real, reproducible
failure I'm documenting rather than papering over, and it happened before
the model-vs-no-model question the adapter usually has to answer even came
up. If your daemon is set up per the README below (which installs it as a
proper background service rather than a bare `serve` in a terminal), this
particular failure mode shouldn't apply to you — but treat the exact spawn
step as documented-from-source, not click-tested end to end, until you've
run it once yourself.

## Setup

### 1. Install the CLI and the daemon

```bash
npm i -g @agentproto/cli
agentproto daemon install     # installs + starts the background daemon
agentproto daemon status      # confirm it's up — default http://127.0.0.1:18790
```

`daemon install` matters more than it looks: it registers the daemon as a
proper background service instead of a foreground `agentproto serve` you'd
have to remember to restart. That also sidesteps the PATH gotcha in this
guide's troubleshooting section, since the service definition captures a
consistent environment instead of whatever your terminal happened to have
sourced.

### 2. Install the codex adapter

```bash
agentproto install codex
```

This resolves `@agentproto/adapter-codex` and wires up the `codex` harness —
OpenAI's Codex agent driven over the [Agent Client
Protocol](https://agentclientprotocol.com) via the maintained
`@agentclientprotocol/codex-acp` wrapper, spawned through a version-pinned
`npx` call. If you haven't already, log into Codex once via the official
CLI (`codex login`) — agentproto's codex profile reads that same login
(it shows up as a `self-refreshing` credential, the same pattern Claude
Code's own OAuth profile uses), so there's no separate agentproto-specific
login step for the model credential itself.

### 3. Install the extension

- **VS Code Marketplace:** search **"agentproto"** in the Extensions view.
  Published as `agentproto.agentproto-vscode` (publisher `agentproto`,
  extension id `agentproto-vscode`) — confirmed from the extension's
  `package.json` and its release workflow, which ships every push to `main`
  to the Marketplace pre-release channel and cuts a stable release on top
  of that.
- **Cursor:** Cursor loads standard VS Code extensions, so the same
  Marketplace search usually works from Cursor's own Extensions panel. If
  it doesn't show up there, grab a `.vsix` from [GitHub
  Releases](https://github.com/agentproto/ts/releases) and use
  **Extensions: Install from VSIX…**, or `code --install-extension
  agentproto-vscode-<version>.vsix` (the equivalent Cursor CLI command if
  you have one on PATH). This is a real fallback, not a hedge — the repo
  ships versioned `.vsix` build artifacts specifically for this case.

### 4. Spawn a Codex session

Open the Command Palette and run **agentproto: Spawn Agent**. Here's what
that command actually does, read straight from its implementation:

- If you have no favorites or recent spawns yet, you land directly on a
  **harness picker** — one row per installed agent CLI (Claude Code, Codex,
  Hermes, …). Pick **codex**.
- That narrows to a **model picker** scoped to just Codex's models (the
  `gpt-5.6-*` family and friends at time of writing) — pick one, or press
  Escape to spawn with the adapter's own default rather than pin a model.
  This is deliberate: a flat picker with every model from every harness
  cross-joined together is the thing this two-step drill-down replaces.
- Once you've spawned anything before, the palette instead opens on a
  **one-click list of favorites and recent spawns** — each row already
  carries its harness, model, and billing wallet, so picking one just
  spawns it. A trailing **"Configure…"** row is always there for the full
  chain (adapter → provider → model → mode → orchestrator → permissions →
  cwd → label → initial prompt) if you need to override something.
- The working directory defaults to whatever folder is open in the active
  editor, shown in the picker's placeholder before you commit — it doesn't
  silently guess in the background.

The spawned session shows up in the agentproto sessions panel, streaming
like any other agent CLI in the extension — prompt it, interrupt it, stop
it, or resume it later, same as a Claude Code or Hermes session. Nothing
in the UI treats Codex as a second-class citizen; it's one harness among
several, picked the same way.

Repeat the same four steps in Cursor — different window, same daemon,
same extension, same picker.

## Troubleshooting: `spawn npx ENOENT`

If a codex (or any `npx`-based) session fails to spawn with something like:

```
failed to spawn 'npx -y @agentclientprotocol/codex-acp@1.1.14': spawn npx ENOENT
```

the adapter and your Codex login are very likely fine — this is the
daemon process itself not seeing `npx` on its `PATH`. It happens when the
daemon was started from an environment where a Node version manager (nvm,
volta, asdf) hasn't been sourced — a `launchd` service, a non-login shell,
or a cron-style invocation, none of which read your `~/.zshrc` or
`~/.bashrc`. Your interactive terminal has `npx` on `PATH` because your
shell profile put it there; the daemon process may not.

Two fixes, in order of how much they touch:

1. **Restart the daemon from a shell where `which npx` resolves.** If you
   started it manually (`agentproto serve`), this is a matter of quitting
   that process from a terminal that has your Node version manager sourced
   and starting it again from there.
2. **Prefer `agentproto daemon install` over a bare `agentproto serve`.**
   The installed background-service path is built to capture a stable,
   correct `PATH` once at setup time, rather than depending on whatever
   shell happened to launch it — which is the whole reason step 1 in this
   guide leads with `daemon install`, not `serve`.

If you're mid-way through several other live sessions on that daemon,
restarting it will interrupt their in-flight turns — it's not silent
background maintenance. Check `agentproto sessions` (or the extension's
session list) for anything currently running before you restart.

## The honest tradeoff

This isn't the simplest way to keep using Codex after November 12. If
Codex is the only harness you care about, OpenAI's own migration paths —
your own API key, the standalone Codex IDE extension — are less setup.
This path is worth it specifically when you want one place to run Codex
*and* Claude Code *and* Gemini *and* whatever else, with sessions that
outlive the IDE window and are reachable from outside it. If that's not
your situation, it's fine to take the simpler road.

[SCREENSHOT: VS Code Command Palette showing "agentproto: Spawn Agent"]

[SCREENSHOT: harness picker with Codex row selected]

[SCREENSHOT: model picker scoped to Codex's gpt-5.6-* models]

[SCREENSHOT: a running Codex session streaming in the agentproto sessions panel]

[SCREENSHOT: the same extension and session list open inside Cursor]

---

Sources: [OpenAI's Cursor model-access cutoff, explained](https://xenospectrum.com/en/openai-cursor-model-access/) · [Cursor forum: Codex extension not working in Cursor 3.15/3.16](https://forum.cursor.com/t/codex-openais-extension-not-working-in-cursor-ide-3-15/168910)
