# `agentproto hook`

Status: Experimental

```text
agentproto hook inbox [--session <id>] [--event <name>] [--max <n>]
agentproto hook pre-compact
agentproto hook install --host claude-desktop [--session <id>] [--settings <path>]
                        [--port <n>] [--dry-run]
```

Claude Code hook commands: `inbox` and `pre-compact`, plus `install` to wire
`inbox` into a Claude Desktop settings file.

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

## Setting up a Claude Desktop session

A Claude Desktop session is an `external` session: the daemon cannot start a
turn in it, so every event (sentinel, `session_follow`, workflow) is parked in
its inbox and shown the next time the user submits a prompt or a tool call
finishes. Three things have to line up:

1. **The MCP URL registers the session.** Connect the app to
   `http://127.0.0.1:18790/mcp?callerSessionId=<id>&host=claude-desktop`
   (18790 is the default daemon port; use `daemon.port` if you changed it).
   The first authenticated request creates the `external` row for `<id>`.
   `<id>` must match `[A-Za-z0-9._:-]{1,128}`. A request over loopback is
   trusted as is; through a tunnel it needs the daemon bearer token, otherwise
   it never registers the session.
   ```sh
   claude mcp add --transport http --scope user agentproto-desktop \
     "http://127.0.0.1:18790/mcp?callerSessionId=<id>&host=claude-desktop"
   ```
2. **`AGENTPROTO_SESSION_ID` must equal that `<id>`.** `hook inbox` reads the
   inbox of the session named by this variable, never the harness's own
   `session_id`, so a mismatch reads an empty inbox and prints nothing.
3. **Two hooks run `agentproto hook inbox`**, on `UserPromptSubmit` and
   `PostToolUse`. `agentproto` must be on the PATH of the app.

The settings file the app reads (`~/.claude/settings.json`, or
`$CLAUDE_CONFIG_DIR/settings.json`) then contains:

```json
{
  "env": { "AGENTPROTO_SESSION_ID": "<id>" },
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "agentproto hook inbox" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "agentproto hook inbox" }] }
    ]
  }
}
```

One settings file means one session id: every Desktop conversation that reads
it shares one inbox. Put the block in a project's `.claude/settings.local.json`
instead to give that project its own id.

### `hook install --host claude-desktop`

Writes the block above for you. It merges into the existing file (other keys,
other hooks and other env vars are kept), is idempotent (a second run changes
nothing), and refuses to touch a file it cannot parse.

| Flag | Default | Description |
|------|---------|-------------|
| `--host <name>` | required | Only `claude-desktop` is supported. |
| `--session <id>` | the id already in the file, else `claude-desktop` | Value of `AGENTPROTO_SESSION_ID` and of `callerSessionId` in the printed MCP URL. |
| `--settings <path>` | `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR` honoured) | Settings file to merge into. |
| `--port <n>` | `18790` | Daemon port used in the printed MCP URL. |
| `--dry-run` | off | Print the merged settings JSON on stdout (and the target path and MCP URL on stderr); write nothing. |

It prints the `claude mcp add` line for step 1; registering the MCP URL stays
manual because Claude Code keeps MCP servers outside the settings file.

### Liveness of an `external` session

An `external` row idle past the liveness window (30 minutes by default) is
shown as `exited`, but it keeps accepting inbox delivery: nothing can restart
it, so events wait in the inbox until the next hook run, and any later MCP
request or inbox poll marks it `running` again. A row that was killed or
retired is refused.

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
That absolute-path fallback is POSIX-only: a win32 daemon falls back to the
bare `agentproto`, resolved on the harness's PATH.
