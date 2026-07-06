# `agentproto run-swarm`

```text
agentproto run-swarm --manifest <path> [--once] [--interval <ms|Ns>]
                                       [--verbose] [--plugin <module-id>]…
```

Runs a multi-agent swarm. Loads the manifest at `<path>`, resolves
every `kind` string through the runtime registry, and runs cycles in
a loop until you Ctrl-C. One cycle =
`read substrate → dispatch → execute → append → fire lifecycle`.

For the conceptual model see [`../concepts/swarms.md`](../concepts/swarms.md).
For port-by-port kernel details see
[`../../../packages/agent-runtime/ARCHITECTURE.md`](../../../packages/agent-runtime/ARCHITECTURE.md).

## Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--manifest <path>`, `-m` | _required_ | Path to the manifest file (YAML-frontmatter markdown, as defined by `@agentproto/agent-runtime`). |
| `--once` | off | Run exactly one cycle, then exit. Useful for cron-style polling. |
| `--interval <ms\|Ns>` | `2000` | Delay between cycles. `500`, `500ms`, `2s` all parse. |
| `--verbose`, `-v` | off | Log each cycle: idle / which participants ran / how many turns appended. Also prints the registered `kind` lists at startup. |
| `--plugin <module-id>` (repeatable) | – | Additional plugin to load *for this invocation*. Loaded after `config.json#plugins` so flag-provided plugins can override config-listed ones. |

## Manifest format

The manifest is markdown with YAML frontmatter:

```yaml
---
schema: agentruntimes/v1
kind: MultiAgentRuntime
id: my-swarm
participants:
  - id: reviewer
    executor: agent-cli
    displayName: Reviewer
    role: ../.claude/agents/reviewer.md
    config:
      model: sonnet
  - id: skeptic
    executor: agent-cli
    displayName: Skeptic
    role: ../.claude/agents/skeptic.md
    config:
      model: opus
substrate:
  kind: file
  path: ./conversation.md
dispatcher:
  kind: mention
state:
  kind: fs
  dir: ./state
---

Free-form documentation of this swarm.
```

All paths are resolved relative to the manifest's directory (the
`baseDir` passed to every adapter factory). `role` may be an inline
string or a relative path to a `.md`/`.txt` file; relative paths are
resolved from the manifest's directory, not from the process cwd.

Per-participant `config` is optional and overrides the executor-kind
defaults only for that participant. For `agent-cli` the supported
fields are `command`, `args`, and `model` (the latter only injects
`--model <model>` when `command` is `claude`). Manifests without
`config` behave exactly as before.

## Built-in `kind` strings

Registered by default — no plugin needed:

| Category | Kind | What it does |
|----------|------|--------------|
| `substrate` | `file` | Append-only markdown journal at `path` (default `.runtime/conversation.md`). |
| `dispatcher` | `mention` | Selects participants @-mentioned in the latest trigger turn. |
| `state` | `fs` | One JSON file per participant under `dir` (default `.runtime/state`). |
| `executor` | `agent-cli` | Spawns an agent-CLI binary. Defaults for `claude` are `--print --output-format=json --permission-mode bypassPermissions` so unattended swarm participants don't hang waiting for interactive tool approval. Override any of this with `config.command` / `config.args`, or set `config.model` to pick a different Claude model for that participant. |

Other `kind`s come from plugins. See
[`../concepts/plugins.md`](../concepts/plugins.md) and
[`./plugins.md`](./plugins.md).

## Verbose output

```bash
agentproto run-swarm --manifest .runtime/multi-agent.yaml --verbose
```

```text
agentproto run-swarm: loaded manifest "my-swarm" from /abs/.runtime/multi-agent.yaml
agentproto run-swarm: participants: Reviewer, Architect
agentproto run-swarm: substrate=file dispatcher=mention state=fs
agentproto run-swarm: registered: substrates=[file] dispatchers=[mention] executors=[agent-cli] stateStores=[fs]
agentproto run-swarm: idle (no mentions)
agentproto run-swarm: executed 1 participant(s); appended 1 turn(s)
…
```

The `registered: …` line is the source of truth for which `kind`s are
available in this process — handy when debugging "unknown kind"
errors.

## Errors

- **`unknown substrate kind '<x>'`** — the manifest references a kind
  that isn't registered. Either install the providing plugin
  (`agentproto plugins install <pkg>`) or pass `--plugin <pkg>`.
  Error message lists currently-registered kinds for context.
- **`unknown dispatcher kind '<x>'`** / **`unknown executor kind '<x>'`** /
  **`unknown state-store kind '<x>'`** — same pattern.
- **`--manifest <path> is required`** — pass `--manifest`.
- **Manifest file not found / malformed YAML** — surfaced through
  `loadManifest` as a plain error message. Check the path and YAML
  syntax.

## Examples

```bash
# Local file-mode swarm using the standard profile's example
agentproto install runtime-profile/standard
cp .claude/examples/swarm-local.md .runtime/multi-agent.md
agentproto run-swarm --manifest .runtime/multi-agent.md --verbose

# One cycle, no loop (great for cron / CI)
agentproto run-swarm --manifest .runtime/multi-agent.md --once

# Tight loop for development iteration
agentproto run-swarm --manifest .runtime/multi-agent.md --interval 500ms -v

# Override with a transport plugin
agentproto plugins install @guilde/agentproto-bridge
agentproto run-swarm --manifest .runtime/guilde.md --verbose

# Or load a plugin for just this run (without persisting)
agentproto run-swarm --manifest ./swarm.md --plugin @your-org/agentproto-something
```

## Cleanup

Adapters that hold disposable resources (sockets, MCP clients, child
processes) register teardown callbacks via the shared
`AdapterContext.registerCleanup`. Those run on Ctrl-C, manifest load
error, or normal exit — so plugins should `registerCleanup(...)`
rather than relying on `process.on("exit")`.
