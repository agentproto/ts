# Which tools can an app agent call?

An `@agentproto/app-kit` app bundles one or more AIP-42 agents, each with its
own `AGENT.md`. This page covers what a `tools:` entry in that frontmatter
can actually resolve to once the daemon spawns the agent — the executor
behind each tool id, and the allowlist rule that keeps an app from reaching
tools it never declared.

> Scope: this page is about the **mastra-agent** adapter (`app_run`'s
> default, and the only adapter whose manifest exposes a resolvable AGENT.md
> — see `[app_run` with another adapter](#app_run-with-a-non-mastra-agent-adapter)
> below). If your app runs its agents under `claude-code`/`hermes`/`codex`
> instead, tool access comes from that adapter's own native MCP mounting —
> ambient config or the daemon's self-mount — not from this resolution
> chain.

## Resolution order

For each id in an agent's `tools:` list, mastra-agent's `default-agent.ts`
(`resolveTool`) tries, in order:

| # | Source | Examples | Backed by |
| --- | --- | --- | --- |
| 1 | **Workspace toolset** | `read_file`, `write_file`, `edit_file`, `list_dir`, `run_command` | Local to the spawned process — reads/writes/execs confined to the agent's `cwd` (`workspace-tools.ts`) |
| 2 | **Curated daemon sub-agent tools** (modes-on only) | `agent_start`, `agent_prompt`, `agent_output`, `session_list` | A small, hand-wired REST client to the daemon (`daemon-client.ts` / `daemon-tools.ts`) |
| 3 | **Generic daemon MCP proxy** (modes-on only) | `app_data_read`, `app_data_write`, `app_data_list`, `mcp_imported_call`, `app_run`, `app_status`, any other daemon-registered MCP tool | A proxy over the daemon's own `/mcp` endpoint (`daemon-mcp-tools.ts`) — `tools/list` once, `tools/call` per invocation |
| — | *(none of the above)* | a typo, or a tool neither this adapter nor the daemon expose | An "unwired" stub that fails fast and clearly the moment it's called, instead of silently hanging the turn |

Tier 3 is what makes `app_data_read`, `mcp_imported_call`, and the rest of
the daemon's own MCP surface reachable from an app agent at all — before
this, any tool id outside tiers 1–2 always landed on the stub, no matter
what the daemon exposed.

## The allowlist rule

**An app agent can only call a tool its own `AGENT.md` declares in
`tools:`.** This isn't a separate check bolted on top — it falls out of how
resolution works: `resolveTool` is invoked once per id the manifest lists,
and tier 3's proxy is only ever *constructed* for an id that invocation
actually asked about. The daemon may expose dozens of other MCP tools (every
other `app_*` verb, `mcp_imported_call`, orchestration tools, ...) — none of
them become callable just because the daemon has them. An app that needs a
new daemon tool must add it to its agent's `tools:` list explicitly.

This is the same allowlist principle `app_tool_call`'s `ui.tools` enforces
for the UI-to-daemon bridge (`APP.md`'s `ui: { tools: [...] }`) — two
different surfaces (a UI panel's fetch calls vs. an agent's tool calls),
same rule: nothing reaches the daemon that wasn't explicitly declared.

## `appId` — filled in for you

`app_data_read` / `app_data_write` / `app_data_list` / `app_run` and most
other `app_*` daemon tools require an `appId` argument — but the model
driving an app agent's session has no way to know its own app id. `app_run`
threads the spawning app's id to the child process (`AGENTPROTO_APP_ID`),
and the tier-3 proxy:

- auto-fills `appId` into any `app_*` call that omits it,
- relaxes `appId` out of the schema shown to the model (so the model isn't
  asked to supply something it doesn't know), and
- never overrides an `appId` a call did supply.

A model calling `app_data_read` from inside its own app therefore only ever
needs to pass `path` — not its own app id.

## `app_run` with a non-mastra-agent adapter

`app_run(adapter: "claude-code" | "hermes" | ...)` doesn't go through any of
this — those adapters' manifests declare no `agent` option, so there's no
per-ref resolution to allowlist against. Instead the spawn is built FROM the
AGENT.md directly: its frontmatter `model` becomes the spawn's default model
and its body becomes the system/prefix of the first prompt. Tool access for
that spawned session then comes entirely from whatever that adapter mounts
on its own (e.g. claude-code/hermes's daemon self-mount, `session-spawn.ts`'s
`shouldInjectDaemonSelfMount`) — the AGENT.md's `tools:` list is not
consulted as an allowlist in this path.

## See also

- [`create-agentproto-app`](./create-agentproto-app.md) — scaffolding a new
  app, including where its `AGENT.md` lives.
- [`agentproto app`](../verbs/app.md) — the CLI verb (`install`/`run`/`serve`/...).
