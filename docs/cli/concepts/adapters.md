# Adapters

An **agent-CLI adapter** is the npm-installable definition of how to
drive a specific CLI agent — claude-code, hermes, opencode,
codex, mastra-agent, openclaw, antigravity, jcode, and whatever your team ships. Adapters
declare:

- Where to download the binary (npm / brew / curl / pip / cargo / go /
  download) — see [`verbs/install.md`](../verbs/install.md).
- How to verify the install (`version_check`).
- Optional post-install setup steps (AIP-29 § Setup; see
  [`verbs/setup.md`](../verbs/setup.md)).
- How to spawn the agent for a single turn or a long-lived session.

The CLI loads adapters by name; the AgentProto runtime treats every
adapter uniformly through `@agentproto/driver-agent-cli`.

## Naming convention

Per the
[`PLUGINS.md`](../../../PLUGINS.md#where-to-publish) conventions:

| Scope                          | Owner                       |
| ------------------------------ | --------------------------- |
| `@agentproto/adapter-<slug>`   | blessed by agentproto-org   |
| `@<vendor>/agentproto-adapter` | vendor-owned                |
| `<slug>-agentproto-adapter`    | community / unscoped        |

The CLI doesn't care about the scope — any package on the resolution
path with a valid `AgentCliHandle` works. The conventions exist for
human discoverability.

## Installing

```bash
agentproto install claude-code
```

The verb resolves `@agentproto/adapter-claude-code` from npm, reads
its manifest, walks the declared `install[]` steps in order until one
succeeds, then runs the optional `setup[]` pipeline. The ledger at
`~/.agentproto/setup/<slug>.json` records what landed so re-runs are
idempotent. Pass `--force` to redo, `--dry-run` to plan, `--skip-setup`
to install but defer configuration.

## Running

Single turn:

```bash
agentproto run claude-code --prompt "Hello"
```

Persistent session:

```bash
agentproto sessions start claude-code --workspace my-project --attach
```

See [`verbs/run.md`](../verbs/run.md) and
[`verbs/sessions.md`](../verbs/sessions.md).

## The mastra-agent adapter

`@agentproto/adapter-mastra-agent` is the **first-party agent** — unlike
the other adapters, it does not wrap an external CLI. It parses an
AIP-42 `AGENT.md` manifest, builds a live Mastra agent
(`@agentproto/mastra`), and serves it over AIP-44 ACP (Agent Client
Protocol). Internally it uses Mastra's model router, which accepts any
`provider/model` string the Mastra gateway can route:

- `anthropic/claude-opus-4-8` → `ANTHROPIC_API_KEY`
- `openrouter/z-ai/glm-5.2` → `OPENROUTER_API_KEY` (the default model)
- `openai/gpt-4.1` → `OPENAI_API_KEY`
- `google/gemini-2.5-pro` → `GOOGLE_GENERATIVE_AI_API_KEY`
- Plus `groq/…`, `xai/…`, `mistral/…`, `deepseek/…`

The adapter includes workspace tools (list_dir, read_file, write_file,
edit_file, run_command) confined to the session cwd, and per-conversation
memory via Mastra's LibSQL (SQLite) store at
`~/.agentproto/mastra-agent/memory.db`.

```bash
# Via the agentproto CLI
agentproto run mastra-agent --model anthropic/claude-opus-4-8 -p "Hello"

# Standalone ACP binary
agentproto-mastra acp --model openrouter/z-ai/glm-5.2
```

See [`models.md`](../verbs/models.md) to list mastra-agent's models with
provider-key status.

## Authoring an adapter

The `defineAgentCli` API lives in `@agentproto/driver-agent-cli`. A
minimal adapter looks like:

```ts
import { defineAgentCli } from "@agentproto/driver-agent-cli"

export const myAgent = defineAgentCli({
  id: "my-agent",
  displayName: "My Agent",
  install: [
    {
      method: "npm",
      package: "my-agent-cli",
      global: true,
    },
  ],
  version_check: {
    cmd: "my-agent --version",
    parse: "v(\\d+\\.\\d+\\.\\d+)",
  },
  spawn: {
    cwd: ".",
    args: ["--print"],
    stdin: "prompt",
  },
})
```

Newly shipped manifest fields (this release):

- `modes` entries can carry `status` (`active`/`noop`/`planned`),
  `status_note`, `bin_args_prepend`, `apply` (`bin_args`/`config`), and
  `env_unset`.
- `options` map entries can carry `bin_args_prepend`, `bin_args_template`,
  `bin_args_append_when_true`, `env`, and `env_unset`.
- `models.deny?: string[]` reserves provider/model patterns (e.g. hermes
  denies Anthropic ids so a dedicated claude-code adapter owns them).
- `models.apply?: "config" | "command" | "arg"` selects how the requested
  model is applied at spawn time (`"config"` is the default; `"arg"` composes
  it into `bin_args` via `models.bin_args_template`, e.g. codex-acp's
  `-c model="<id>"`).
- `models.allowed` entries can be bare id strings (back-compat) or structured
  objects `{ id, provider?, mode? }` that bind a model to its billing provider
  and adapter mode. This is what lets model pickers (e.g. the VS Code extension)
  pin the gateway when a user selects a model. (This manifest-level binding is
  what the runtime surfaces per-session as the **`route`** config axis — the
  endpoint/gateway rail; see [`verbs/sessions.md`](../verbs/sessions.md#config-axes-mcphttp).)
- `routeSelection?: "free" | "derived-from-model"` tells the launch UI how the
  route is chosen. `"free"` (default) means the user picks the route
  independently; `"derived-from-model"` means the endpoint is implied by the
  model id's vendor prefix (e.g. `pi`/`opencode`).
- `modelDerivedApiKey?: boolean` marks adapters whose API-key auth is derived
  from the requested model rather than a fixed `provider` (e.g. `pi`,
  `opencode`, `mastracode`).
- `authSubscription?: { setEnv?: string, external?: true, conflictEnv?: string[], unsetEnvAdd?: string[] }`
  declares subscription (OAuth) billing support. `external: true` is the
  file-based / "use my existing login" shape (Codex, Gemini): the CLI reads
  its own login file, the runtime injects nothing, and only scrubs conflicting
  api-key env vars. `setEnv` is the bearer-injection shape (Claude Code). The
  two are mutually exclusive.
- `print.event_schema?: "claude-stream-json" | "mastra-jsonl" | "antigravity-stream-json"`
  selects the wire-event taxonomy for `protocol: "print"` adapters. The
  `antigravity-stream-json` value is new this release and drives Google
  Antigravity's `--output-format stream-json` output.

The AgentProto spec for the adapter shape is AIP-45 — see
<https://agentproto.sh/docs/aip-45>.

## Generic ACP agents (zero-code)

Not every ACP agent needs its own npm adapter package. AgentProto's ACP
protocol arm is fully adapter-agnostic — it performs the standard
[Agent Client Protocol](https://agentclientprotocol.com) `initialize` /
`session/new` handshake over stdio JSON-RPC regardless of which binary is
on the other end. So **any CLI that already speaks ACP is connectable with
zero code**, from a plain spawn recipe rather than a published package.

Two sources feed generic ACP agents:

- **Curated catalog** (`ACP_CATALOG`) — a conservative, built-in list of
  known, publicly-documented ACP CLIs (e.g. Gemini CLI via
  `gemini --experimental-acp`). Every entry ships with an install hint.
- **Config-defined agents** — your own entries under `acpAgents` in
  `~/.agentproto/config.json`. A config entry **shadows** a catalog entry
  of the same slug.

### Config format

```jsonc
{
  "acpAgents": {
    "my-agent": {
      "bin": "my-agent",              // executable to spawn (required)
      "bin_args": ["acp"],            // extra argv, e.g. the ACP flag
      "name": "My Agent",             // display name (default: the slug)
      "description": "…",             // one-line summary
      "env": { "MY_FLAG": "1" },      // always-on spawn env
      "resumable": true,              // advertise native-resume continuation
      "models": { "default": "m", "allowed": ["m"] },
      "install_hint": "npm i -g my-agent"
    }
  }
}
```

The working directory is passed to the agent over ACP (`session/new` `cwd`),
so most agents need nothing beyond `bin` + `bin_args`.

### The `acp` verb

Manage generic agents without hand-editing the config:

```bash
agentproto acp ls                                        # catalog + config, with status
agentproto acp add my-agent --bin my-agent --args acp    # writes config.acpAgents
agentproto acp rm my-agent                               # removes a config entry
```

See [`verbs/acp.md`](../verbs/acp.md).

### Resolution precedence

`agentproto run <slug>` (and every other path through `resolveAdapter`)
resolves a slug in this order:

1. **npm** — `@agentproto/adapter-<slug>` (a real adapter package always
   wins).
2. **config** — `config.acpAgents[<slug>]`.
3. **catalog** — `ACP_CATALOG`.

So a published adapter is never shadowed by a generic spec, and your config
overrides the built-in catalog. In `adapter_list` / `GET /adapters`, generic
agents appear with status `available` (bin found on `PATH`) or `supported`
(not installed — shows the install hint).

Reach for a real adapter package (not a generic spec) when the agent needs
bespoke env scrubbing, gateway modes, permission handling, or a non-stdio
transport.

## Adapter vs plugin

These are different things:

- **Adapter** drives a specific CLI agent. Goes through `agentproto
  install <slug>`. Pulled in by `agentproto run`, `agentproto
  sessions`, and the daemon's `participant.executor = agent-cli`
  swarm executor.
- **Plugin** extends the swarm kernel with new substrates,
  dispatchers, executors, or state stores. Goes through `agentproto
  plugins install <pkg>`. See [`./plugins.md`](./plugins.md).

Most users only ever install adapters. Plugins matter when you want
swarms to read/write through a non-default transport (Slack, MCP,
custom chat) or to add a dispatcher that isn't built in.
