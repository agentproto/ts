# agentproto for VS Code

**Run, watch, and supervise every AI coding agent — Claude Code, Codex, Hermes,
opencode, Mastra — from your editor.** This extension is a live front-end for a
local [agentproto](https://agentproto.sh) daemon: spawn agents, stream their
work, approve tool permissions, manage provider credentials, and drive
sessions (prompt / interrupt / stop / resume) without leaving VS Code.

> agentproto is the daemon that powers your harnesses — one protocol, every
> agent CLI, any model, any provider.

---

## Requirements

The extension is a **client for the agentproto daemon** — it doesn't run agents
itself. You need the CLI installed and the daemon running:

```bash
npm i -g @agentproto/cli      # the `agentproto` command
agentproto daemon install     # install + start the background daemon
agentproto daemon status      # verify it's up (default: http://127.0.0.1:18790)
```

Install at least one **harness** (an agent CLI) so you have something to run —
e.g. Claude Code:

```bash
agentproto install claude-code
# others: codex · hermes · opencode · mastracode · aider …
```

Node.js ≥ 20 · VS Code ≥ 1.90.

## Install

- **Marketplace:** search **“agentproto”** in the Extensions view and install.
- **Pre-release builds** (bleeding edge, one per push): click the **Switch to
  Pre-Release Version** button on the extension page.
- **VSIX:** grab a `.vsix` from
  [GitHub Releases](https://github.com/agentproto/ts/releases) →
  **Extensions: Install from VSIX…**, or
  `code --install-extension agentproto-vscode-<version>.vsix`.

## Quick start

1. Start the daemon (`agentproto daemon start`).
2. Open the **agentproto** icon in the Activity Bar.
3. First run: **Set Up Credentials** — the Auth Profiles view walks you through
   connecting a provider or adopting your existing local login (see
   [Credentials & auth](#credentials--auth)).
4. Hit **＋ Spawn Agent** in the Sessions view — pick a harness, model, and
   folder — and watch it work. Prompt it, approve its tool calls, or stop it,
   all from the panel.

---

## The panels

The extension adds two Activity Bar containers.

### agentproto

- **Sessions** — every session on the daemon, grouped by workspace. Spawn,
  **prompt**, **interrupt**, **stop**, **restart** (fresh) or **resume in
  place**; rename, favorite, archive; open the **transcript**, **story**
  (readable timeline), or a live **terminal**; filter, search, and group. Also
  imports a Claude Code conversation and cleans up ended sessions / worktrees.
  A session with a dead adapter stream mid-turn shows a **⚠ stall badge** with
  the silent duration.
- **Permissions** — when a session runs in **permission-hold** mode, every tool
  request (Write, Bash, …) is parked here for you to **Approve** or **Deny**.
  Turn holds on globally with `agentproto.holdPermissions`, or per session.
- **Harnesses** — the agent CLIs available to the daemon. **Install** a new
  harness or **Spawn with** a specific one.
- **Auth Profiles** — named credential profiles for the models your agents
  bill against: connect a provider, adopt your local login, enable/disable, set
  allowed models, and run the built-in **Local Router**.
- **Apps** — every app installed on the daemon (`app_list`), grouped by its
  `app_catalog` category (**Apps**, **Teams**, …). Expand an app to its
  **agents** and **workflows**; click one to read its `AGENT.md` /
  `WORKFLOW.md`. An app that ships a UI opens its **panel** on click (or in a
  browser tab); an agent/workflow-only app opens its `APP.md` instead. **Run
  workflow…** on a workflow row starts it on the daemon.

### Agentproto Lab

- **Configuration Lab** — a UI for a session’s configuration axes (model,
  effort, posture, …) before or after spawn.

---

## Credentials & auth

There are **two** layers of auth. The extension handles the first for you.

### 1. Talking to the daemon (automatic, local)

The extension connects to `http://127.0.0.1:18790` and authenticates using the
daemon’s own runtime token, auto-resolved from
`~/.agentproto/daemons/<port>.json`. If the daemon is running locally, **there’s
nothing to configure** — the Sessions view just populates.

### 2. Provider credentials (how your agents bill)

Agents need a model provider (Anthropic, OpenAI, OpenRouter, Google, …). Set
this up once from the **Auth Profiles** view:

- **Set Up Credentials (Onboarding)** — guided first-run flow.
- **Connect Provider** — add an API key for a provider (stored by the daemon,
  never re-displayed).
- **Use My Existing Local Login** — adopt your existing Claude Code login as a
  **self-refreshing** profile (bills your Max/Pro subscription, not API
  credits). The `agentproto.autoAdoptLocalLogin` setting can do this
  automatically on activation.
- **Set Allowed Models…** — scope which models a profile may run.
- **Local Router** (Start / Stop / Test Upstream / Link Credential) — run the
  daemon’s Anthropic-compatible gateway so a harness can reach custom providers.

### Connecting to a remote daemon

Point the extension at a non-local daemon (e.g. an attached sandbox’s gated
URL) with:

```jsonc
{
  "agentproto.daemonUrl": "https://my-daemon.example.dev",
  // headers to authenticate the remote daemon (cookie, bearer, …)
  "agentproto.authHeaders": { "Authorization": "Bearer <token>" }
}
```

Or set `agentproto.tokenPath` to an explicit runtime-token file.

---

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `agentproto.daemonUrl` | `http://127.0.0.1:18790` | Base URL of the daemon. |
| `agentproto.tokenPath` | `""` | Explicit path to the daemon’s runtime-token file. Empty = auto-resolve. |
| `agentproto.authHeaders` | `{}` | Extra HTTP headers to authenticate a remote daemon. |
| `agentproto.pollIntervalMs` | `5000` | Fallback poll interval when the live event stream is unhealthy. |
| `agentproto.holdPermissions` | `false` | Spawn sessions in permission-hold mode (tool calls parked for approval). |
| `agentproto.confirmStop` | `true` | Ask before stopping a session. |
| `agentproto.sessionGrouping` | `workspace` | How the Sessions panel groups its top level. |
| `agentproto.hideMachineSessions` | `true` | Hide machine-origin sessions (e.g. automated gate reviews). |
| `agentproto.autoAdoptLocalLogin` | `ask` | On activation, adopt an existing local Claude login as an auth profile. |
| `agentproto.sessionsView` / `harnessesView` / `authProfilesView` | `tree` | Which panel style to show in the sidebar. |

## Handy commands

Open the Command Palette (`⇧⌘P`) and type **agentproto**:

- **Spawn Agent** · **Prompt Session** · **Interrupt Session** · **Stop
  Session** · **Resume Session In Place**
- **Open Transcript** · **Open Story** · **Open Terminal**
- **Approve / Deny Permission**
- **Install Harness** · **Spawn with Harness**
- **Set Up Credentials (Onboarding)** · **Connect Provider** · **Use My
  Existing Local Login**
- **Show Daemon Health** · **Select Target Workspace**

---

## Troubleshooting

- **Empty Sessions view / “can’t reach daemon.”** Run `agentproto daemon
  status`; start it with `agentproto daemon start`. Confirm `agentproto.daemonUrl`
  matches the daemon’s port.
- **Agents error immediately / “empty turn.”** Usually a provider-credential
  issue — open **Auth Profiles** and connect a provider or adopt your local
  login.
- **No harnesses to spawn.** Install one: `agentproto install claude-code`.

## Links

- Website & docs — **[agentproto.sh](https://agentproto.sh)**
- Source & releases — [github.com/agentproto/ts](https://github.com/agentproto/ts)

---

## Development

From `packages/vscode`:

```bash
pnpm run build        # bundle src/extension.ts → dist/extension.js
pnpm run check-types
pnpm test
pnpm package          # build a local VSIX → output/agentproto-vscode-<version>.vsix
```

Releases are automated: pushes to `main` touching `packages/vscode/**` publish a
pre-release build (`vscode-release.yml`); a Version Packages merge publishes the
stable channel (`release.yml`). Licensed Apache-2.0.
