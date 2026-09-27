# app_run

Run an installed app's agents as live sessions — one `agent_start`-equivalent
spawn per selected agent, grouped under a fresh appRunId. Re-reads the app's
directory first, so a stale install record (paths moved, a workflow renamed)
is refreshed before spawning — the same refreshed paths are what make
`workflow_run_file` work against this app's WORKFLOW.md files. Poll with
`app_status`, kill with `app_stop`.

## adapter support

The AGENT.md frontmatter `model` becomes each spawn's model when `model` is
omitted here; if neither is set, the adapter keeps its default. With the
default adapter `mastra-agent` (or any other adapter whose manifest
declares an `agent` option), each spawn is also pointed straight at the
agent's emitted AGENT.md via that option. Any OTHER adapter (`claude-code`,
`hermes`, `codex`, ...) declares no such option, so its spawn is built FROM
the AGENT.md instead: the AGENT.md body becomes the system/prefix of the
first prompt (a `prompt` arg is appended after it). An explicit `model` arg
here always wins. `cwd` is still the app's dir, and the daemon's own MCP
gateway is still mounted for adapters that get it by default (claude-code,
hermes) — see `shouldInjectDaemonSelfMount` — so the spawned agent still
reaches `app_data_*`/`mcp_imported_call` natively.

## orchestration

Pass `sequence` to run agents ONE-AT-A-TIME in the given order (each waits
for its predecessor's session to reach a terminal state, bounded ~60×2s,
before the next spawns) — the scout→tailor workflow. By default the tool
waits for the whole sequence, preserving existing behaviour. Pass
`wait:false` to return the appRunId after the first session spawns and
continue the remaining sequence in the background; follow it with
`app_status`. Without `sequence`, `agents` spawn concurrently (legacy
behaviour). When `sequence` is set every agent still lives under the SAME
appRunId and is awaited (unless `wait:false`); the run is marked `ended`
once the last completes.

## runner selection

`adapter`/`harness`/`model` are passed through to every spawn and mirrored
onto the run record for observability. `harness` is the canonical slug and
defaults `adapter` to itself when `adapter` is absent; a bare `adapter`
sets `harness` to itself; both default to `mastra-agent`. `access.profileRef`
pins a named auth profile (see `agent_start.access`) on every spawn this
run makes — needed when an adapter's default credential profile is
disabled on this host. An unresolvable adapter is collected as a per-agent
error rather than failing the whole run.
