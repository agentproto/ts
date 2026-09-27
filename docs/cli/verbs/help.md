# `agentproto help`

```text
agentproto help <tool> [--topic <section>]
```

Long-form docs for one of the daemon's MCP tools — the same text a live
session gets by calling the `tool_help` MCP tool. Reads
`docs/mcp-tools/<tool>.md` straight out of the installed `@agentproto/runtime`
package (via `getToolHelp`), so it needs no running daemon and no network.

Tool schemas (`tools/list`) stay short by design: each description is a
one-line contract plus the rule that prevents a wrong call. The detail that
used to live inline — edge cases, cross-field interactions, examples — moved
here instead, one `##` heading per field, fetched on demand.

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--topic <section>` | *(whole doc)* | Print just the `## <section>` heading instead of the full page. Falls back to the whole doc if the heading doesn't exist. |
| `-h`, `--help` | | Usage. |

## Exit code

`1` when no doc exists for `<tool>` (prints the list of tools that do have
one), `0` otherwise.

## Examples

```bash
# The whole agent_start doc
agentproto help agent_start

# Just the `worktree` field's detail
agentproto help agent_start --topic worktree
```

## See also

- `tool_help` — the MCP-tool equivalent, for an agent session mid-conversation
