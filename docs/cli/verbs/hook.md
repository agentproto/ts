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
| `--session <id>` | see below | Session whose inbox to read. First valid value wins: `--session`; `$AGENTPROTO_SESSION_ID` when it starts with `sess_`; `cc:` + the payload's `session_id`; then `$AGENTPROTO_SESSION_ID` when the payload has no session id. `$CLAUDE_CODE_SESSION_ID` is never read. |
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
   `<id>` is the external row's daemon-side session id: the id sentinels and
   `session_follow` address (e.g. `claude-desktop`), not the harness's per-chat
   `session_id`. It must match `[A-Za-z0-9._:-]{1,128}`. A request over loopback
   is trusted as is; through a tunnel it needs the daemon bearer token, otherwise
   it never registers the session.
   ```sh
   claude mcp add --transport http --scope user agentproto-desktop \
     "http://127.0.0.1:18790/mcp?callerSessionId=<id>&host=claude-desktop"
   ```
2. **The inbox id comes from the payload.** Each Claude Desktop chat carries
   its own `session_id` in the hook payload, and `hook inbox` reads
   `cc:<session_id>` for it. An `AGENTPROTO_SESSION_ID` starting with `sess_`
   (a daemon-spawned session) still takes precedence; any other
   `AGENTPROTO_SESSION_ID` is a legacy fallback used only when the payload
   has no usable `session_id`. To pin a fixed custom id, pass
   `--session <id>` in the hook command.
3. **Two hooks run `agentproto hook inbox`**, on `UserPromptSubmit` and
   `PostToolUse`. `agentproto` must be on the PATH of the app.

The settings file the app reads (`~/.claude/settings.json`, or
`$CLAUDE_CONFIG_DIR/settings.json`) then contains:

```json
{
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

One settings file no longer means one shared inbox: `hook inbox` resolves each
Desktop chat's payload to its own `cc:<session_id>` inbox instead of the
global id. The hook registers that row on first use, so `agentproto send
cc:<session_id> ...` (or `message_send`) works without an MCP connection first.

### Migration for machines already installed

Installing no longer writes `env.AGENTPROTO_SESSION_ID`; each chat uses
`cc:<session_id>`. A legacy `claude-desktop` value is removed, any other value
left untouched. Re-run `agentproto hook install --host claude-desktop` (or
delete the variable from `~/.claude/settings.json`), then restart open chats.
Daemon-spawned `sess_...` sessions are unchanged; per-chat MCP identity is
still pending (headersHelper unverified).

### `hook install --host claude-desktop`

Writes the block above for you. It merges into the existing file (other keys,
other hooks and other env vars are kept), is idempotent (a second run changes
nothing), and refuses to touch a file it cannot parse. It no longer writes
`env.AGENTPROTO_SESSION_ID`; a legacy `claude-desktop` value is removed.

| Flag | Default | Description |
|------|---------|-------------|
| `--host <name>` | required | Only `claude-desktop` is supported. |
| `--session <id>` | `claude-desktop` when no legacy value is present | `callerSessionId` in the printed MCP URL; not written to `env`. |
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
