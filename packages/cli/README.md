# @agentproto/cli

The `agentproto` binary — install, run, and serve [AIP-45 agent CLIs](https://agentproto.sh/docs/aip-45).

```bash
npm install -g @agentproto/cli
```

This installs the `agentproto` executable on your `PATH`.

## Verbs

```text
agentproto install <slug>            install an adapter's underlying CLI
agentproto run     <slug> [opts]     spawn the adapter, dispatch a turn, stream events
agentproto serve   --connect <url>   long-running daemon (relays spawns over a tunnel)
```

### `run`

```bash
# install an adapter package once
npm i -g @agentproto/adapter-claude-code

# run a one-shot turn against the current directory
agentproto run claude-code --cwd . --prompt "what does this repo do?"

# pipe a prompt over stdin
echo "summarise CHANGELOG.md" | agentproto run claude-code

# resume an existing protocol session
agentproto run claude-code --resume <session-id>
```

Output is human-readable by default; pass `--json` for one-event-per-line NDJSON.

### `install`

```bash
agentproto install claude-code              # idempotent, skips if version_check passes
agentproto install claude-code --force      # reinstall regardless
agentproto install claude-code --dry-run    # print steps, don't execute
```

v0.1 implements the `npm` install method; other package managers print a clear "not yet" message and exit non-zero.

### `serve` *(coming soon)*

Long-running daemon that exposes locally-installed adapters to a remote host over a WebSocket tunnel. Wire protocol still being designed; the verb is parsed but currently exits 64 with a tracking message.

## Adapter resolution

`<slug>` resolves to the npm package `@agentproto/adapter-<slug>`. Install adapters globally so `agentproto` can find them on its `NODE_PATH`. Built-in adapters as of v0.1:

- `@agentproto/adapter-claude-code` — Anthropic Claude Code via [@agentclientprotocol/claude-agent-acp](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)
- `@agentproto/adapter-hermes` — generic Hermes-flavoured agents
- `@agentproto/adapter-mastra` — Mastra agents

## License

MIT — see [LICENSE](./LICENSE).
