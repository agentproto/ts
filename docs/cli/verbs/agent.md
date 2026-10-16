# `agentproto agent`

```text
agentproto agent create <slug> [dir] [--force]
                                 [--model <id>] [--description <text>]
agentproto agent list [dir]
```

Author and inspect AIP-42 agent manifests in the canonical hand-written
layout `<dir>/.agents/<slug>/AGENT.md` — the one `loadAgent` and the daemon's
`self_inspect` read first (an app emitted by `app-kit` writes under
`.agentproto/agents/<id>/AGENT.md` instead; both are discovered). Neither
verb needs a running daemon.

`create` renders a valid `agent/v1` AGENT.md through the same
`renderAgentManifest` the `app emit` path and the daemon's `create_agent`
tool use, so a hand-created manifest is byte-identical to an emitted one.
The frontmatter carries `schema: agent/v1`, `id: <slug>`, a `description`,
a `model`, and empty `tools` / `skills` / `workflows` / `routines` sets; the
body is empty.

| Flag | Default | Description |
|------|---------|-------------|
| `<slug>` | required | AIP-42 id (an `@owner/` prefix is allowed). Validated by `defineAgent`; an invalid slug exits `1`. |
| `[dir]` | `.` | Base directory the `.agents/` tree is rooted at. |
| `--force` | off | Overwrite an existing manifest. Without it, `create` refuses and exits `1`. |
| `--model <id>` | `claude-sonnet-5` | Model id stamped into the frontmatter. |
| `--description <text>` | `Agent <slug>.` | One-paragraph purpose. |

`list` scans `<dir>/.agents/` and prints one line per agent directory that
carries an AGENT.md — `id -> path`, with `name` / `version` appended when the
frontmatter declares them. A directory without an AGENT.md is skipped, as is
an absent `.agents/` (prints "no agents under …").

Exit codes: `0` on success, `1` on any failure (invalid slug, existing
manifest without `--force`, unreadable directory).
