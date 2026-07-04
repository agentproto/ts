# Adapters

An **agent-CLI adapter** is the npm-installable definition of how to
drive a specific CLI agent — claude-code, hermes, opencode,
codex, mastra-agent, openclaw, and whatever your team ships. Adapters
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

The AgentProto spec for the adapter shape is AIP-45 — see
<https://agentproto.sh/docs/aip-45>.

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
