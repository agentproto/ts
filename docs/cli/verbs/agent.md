# `agentproto agent`

```text
agentproto agent create <slug> [dir] [--force]
                                 [--model <id>] [--description <text>]
                                 [--grant <action>]...
agentproto agent list [dir]
```

Author and inspect AIP-42 agent manifests in the canonical hand-written
layout `<dir>/.agents/<slug>/AGENT.md` — the one `loadAgent` and the daemon's
`self_inspect` read first (an app emitted by `app` writes under
`.agentproto/agents/<id>/AGENT.md` instead; both are discovered). Neither
verb needs a running daemon.

`create` renders a valid `agent/v1` AGENT.md through the same
`renderAgentManifest` the `app emit` path and the daemon's `create_agent`
tool use, so a hand-created manifest is byte-identical to an emitted one.
The frontmatter carries `schema: agent/v1`, `id: <slug>`, a `description`,
a `model`, and empty `tools` / `skills` / `workflows` / `routines` sets; the
body is empty. With `--grant`, it also carries `actions.granted`.

| Flag | Default | Description |
|------|---------|-------------|
| `<slug>` | required | AIP-42 id (an `@owner/` prefix is allowed). Validated by `defineAgent`; an invalid slug exits `1`. |
| `[dir]` | `.` | Base directory the `.agents/` tree is rooted at. |
| `--force` | off | Overwrite an existing manifest. Without it, `create` refuses and exits `1`. |
| `--model <id>` | `claude-sonnet-5` | Model id stamped into the frontmatter. |
| `--description <text>` | `Agent <slug>.` | One-paragraph purpose. |
| `--grant <action>` | none | Repeatable. Writes the action to `actions.granted`. `--grant create_tool` lets the agent author tools with the daemon's `create_tool` verb. An empty value exits `1`. |

Nothing is granted by default. A grant is an elevation: `create_tool` lets
the agent add a tool the daemon runs for it. Each run of a created tool still
needs a human approval (`created_tool_call`, below), but which agents may
author tools is a decision the operator makes explicitly, per agent.

The daemon's `create_agent` tool takes the same option as `grants: [...]`,
with one more rule: a calling agent may only grant actions its own manifest
already holds, so an agent cannot create a more privileged agent than itself.

### Using a created tool

`create_tool` writes `.agentproto/tools/<id>/TOOL.md` and its DRIVER.md in the
daemon workspace. A session runs it with the daemon verb `created_tool_call`,
which is in every session's tool list from the start, so the session that
created the tool can call it in the same turn, with no restart:

1. `created_tool_call` with `id` and `args`, no approval: it is refused with
   the exact request to make, `kind: "created_tool_call"` and
   `payload: { tool, args, toolSha256 }` (a hash of the TOOL.md and
   DRIVER.md), plus a preview showing the command the driver runs;
2. `approval_request` with that request; a human approves it (approval card,
   web or Telegram); `approval_wait`;
3. `created_tool_call` again with `id`, the same `args` and `approvalId`.

One approval runs the tool once, for those exact arguments and those exact
tool files, for the session that asked. A call without an approval is refused with the request to make.
The `approval` class the TOOL.md declares does not lift this: it was written
by the agent that created the tool. Only tools `create_tool` authored (they
carry an `.authoring.json` marker) run this way.

`list` scans `<dir>/.agents/` and prints one line per agent directory that
carries an AGENT.md — `id -> path`, with `name` / `version` appended when the
frontmatter declares them. A directory without an AGENT.md is skipped, as is
an absent `.agents/` (prints "no agents under …").

Exit codes: `0` on success, `1` on any failure (invalid slug, existing
manifest without `--force`, unreadable directory).
