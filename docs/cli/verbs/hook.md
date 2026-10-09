# `agentproto hook`

Status: Experimental

```text
agentproto hook inbox [--session <id>] [--event <name>] [--max <n>]
```

Claude Code hook commands. Today there is one: `inbox`.

## `hook inbox`

Meant to run as a Claude Code `UserPromptSubmit` or `PostToolUse` hook. It
reads the session's unread AIP-46 inbox from the daemon
(`GET /sessions/:id/inbox`), prints the oldest items as `additionalContext`
in the hook JSON protocol, then acks exactly the items it printed
(`POST /sessions/:id/inbox/ack`). This is how a Claude Desktop or `claude`
CLI session that the daemon did not spawn (an `external` session) sees
sentinel, `session_follow` and workflow notifications.

The injected text is wrapped in an `<agentproto-inbox untrusted="true">`
block that tells the model the items are data, not instructions. An item
containing the closing tag has it neutralised, and each item is truncated at
2000 characters.

| Flag | Default | Description |
|------|---------|-------------|
| `--session <id>` | `$CLAUDE_CODE_SESSION_ID`, else the hook payload's `session_id` | Session whose inbox to read. |
| `--event <name>` | the payload's `hook_event_name`, else `UserPromptSubmit` | Hook event name echoed in the output (`UserPromptSubmit` \| `PostToolUse`). |
| `--max <n>` | `20` | Maximum items per invocation (capped at 20), oldest first. |

The command never fails the hook: with no daemon, an unknown session, an
empty inbox or any error it prints nothing and exits `0`.

Example `settings.json` entry:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "agentproto hook inbox" }] }
    ]
  }
}
```

The session must already be registered with the daemon: an MCP connection to
`/mcp?callerSessionId=<id>&host=claude-desktop` registers it on its first
authenticated request.
