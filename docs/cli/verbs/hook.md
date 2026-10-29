# `agentproto hook`

Status: Experimental

```text
agentproto hook inbox [--session <id>] [--event <name>] [--max <n>]
agentproto hook pre-compact
```

Claude Code hook commands: `inbox` and `pre-compact`.

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
| `--session <id>` | `$AGENTPROTO_SESSION_ID` | Session whose inbox to read. The payload's `session_id` and `$CLAUDE_CODE_SESSION_ID` are the harness's own and are ignored. |
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

## `hook pre-compact`

The Claude Code `PreCompact` hook the daemon projects into a claude-code
session's isolated `settings.json` when
`defaults.nativeHooks.preCompactCheckpoint` is `"on"` (see
[config schema](../reference/config-schema.md)). It is synchronous and
matches `auto` only: Claude Code waits for it before compacting its own
context, and a `/compact` the daemon sends already checkpoints first.

It reads the hook payload on stdin and posts
`{ reason: "native-pre-compact", occurrenceId, trigger }` to
`POST /sessions/:id/checkpoint` with the daemon token. The session is
`$AGENTPROTO_SESSION_ID` (the daemon session id), never the payload's
`session_id`, which is Claude's own id. `occurrenceId` is
`pc-<transcript size in bytes>` (or `pc-t<unix seconds>` when the transcript
cannot be read), so a repeated hook for the same compaction is answered with
the first checkpoint (`deduped: true`).

It prints nothing on stdout, gives up after 20 s and always exits `0`: a
missed checkpoint never blocks the compaction (the
`agentproto:context-compacted` event then reports `guarded: false`). A failed
request writes one line on stderr,
`agentproto hook pre-compact: checkpoint skipped (<reason>)`, never the
token, the environment or the payload.

The command is `<defaults.nativeHooks.command> hook pre-compact`. When the
key is unset it runs the CLI that serves the daemon, by absolute path, so a
daemon with a minimal PATH still finds it; set a value there to override it.
