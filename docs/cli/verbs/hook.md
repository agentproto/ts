# `agentproto hook`

Status: Experimental

```text
agentproto hook inbox [--session <id>] [--event <name>] [--max <n>]
agentproto hook pre-compact
agentproto hook pr-stamp
agentproto hook install --host claude-desktop [--session <id>] [--settings <path>]
                        [--port <n>] [--dry-run]
```

Claude Code hook commands: `inbox`, `pre-compact` and `pr-stamp`, plus
`install` to wire `inbox` and `pr-stamp` into a Claude Desktop settings file.

## `hook inbox`

Meant to run as a Claude Code `UserPromptSubmit`, `PostToolUse`,
`SessionStart`, `Stop` or `Notification` hook. It
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
| `--event <name>` | the payload's `hook_event_name`, else `UserPromptSubmit` | Hook event name echoed in the output (`UserPromptSubmit` \| `PostToolUse` \| `SessionStart` \| `Stop` \| `Notification`). Any other name is treated as `UserPromptSubmit`. A `Notification` event only touches the session and reads no inbox. |
| `--max <n>` | `20` | Maximum items per invocation (capped at 20), oldest first. |

`SessionStart` prints the same block and the same
`hookSpecificOutput.additionalContext` shape as `UserPromptSubmit`, once per
chat start, resume, clear or compaction.

`Stop` is different: it cannot add context after the turn, it can only keep the
turn going. It prints
`{"decision":"block","reason":"<the same inbox block>"}` (the model continues
with `reason` as its input) only when an unread item with urgency `steer` or
`interrupt` (the must-wake classes) is anywhere in the inbox — the predicate
scans all unread items, not just the ones it prints — **and** the payload's
`stop_hook_active` is not `true`. Otherwise it prints nothing and acks nothing:
`fyi` and `next-turn` items wait for the next prompt, tool call or start, and a
turn that was already continued by a Stop hook is never continued twice. When
it blocks it acks every item it put in `reason`, so an ignored block is gone.
At most one extra turn per natural turn end; it cannot reach a session that has
been idle for an hour.

`SessionStart` and `Stop` stay silent when the id comes from the legacy env
fallback (`AGENTPROTO_SESSION_ID` not starting with `sess_`, no payload
`session_id`): that is a shared inbox, not a per-chat one, and injecting on
start or blocking a stop there would be wrong.

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
its inbox and shown the next time the user submits a prompt, a tool call
finishes or a chat starts (a `steer` or `interrupt` item also keeps a turn that
is ending going, through the `Stop` hook). Three things have to line up:

1. **The MCP URL registers the shared identity.** Connect the app to
   `http://127.0.0.1:18790/mcp?callerSessionId=claude-desktop&host=claude-desktop`
   (18790 is the default daemon port; use `daemon.port` if you changed it).
   The first authenticated request creates the `external` row
   `claude-desktop`, and every Claude Desktop chat shares it. It must match
   `[A-Za-z0-9._:-]{1,128}`. A request over loopback is trusted as is; through
   a tunnel it needs the daemon bearer token, otherwise it never registers the
   session.
   ```sh
   claude mcp add --transport http --scope user agentproto-desktop \
     "http://127.0.0.1:18790/mcp?callerSessionId=claude-desktop&host=claude-desktop"
   ```
2. **The inbox id comes from the payload.** Each Claude Desktop chat carries
   its own `session_id` in the hook payload, and `hook inbox` reads
   `cc:<session_id>` for it. An `AGENTPROTO_SESSION_ID` starting with `sess_`
   (a daemon-spawned session) still takes precedence; any other
   `AGENTPROTO_SESSION_ID` is a legacy fallback used only when the payload
   has no usable `session_id`. To pin a fixed custom id, pass
   `--session <id>` in the hook command.
3. **Five hooks run `agentproto hook inbox`**, on `UserPromptSubmit`,
   `PostToolUse`, `SessionStart`, `Stop` and `Notification`. `agentproto` must
   be on the PATH of the app.

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
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "agentproto hook inbox" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "agentproto hook inbox" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "agentproto hook inbox" }] }
    ]
  }
}
```

For PR provenance there is one more entry: `agentproto hook pr-stamp` as a
second `PostToolUse` hook with matcher `Bash` (see
[`hook pr-stamp`](#hook-pr-stamp) below). `hook install` adds it for you; add
it by hand to the `PostToolUse` array if you are wiring the file yourself.

The Chat tab is one shared, anonymous identity: every Claude Desktop chat
connects as `claude-desktop` and sees the same inbox, and it pulls that inbox
with `inbox_list` rather than relying on a per-chat push. Nothing proves that
a client claiming `claude-desktop` is Claude Desktop, so any local process can
forge the id; messages delivered from it are labelled `unverified`. Use the
Code tab (a `claude` CLI session registered with its own `sess_...` id, which
the daemon can attest) when you need a proven identity.

### Migration for machines already installed

Installing no longer writes `env.AGENTPROTO_SESSION_ID`; the MCP URL carries
the shared `claude-desktop` identity. A legacy `claude-desktop` value is
removed, any other value left untouched. Re-run `agentproto hook install
--host claude-desktop` (or delete the variable from
`~/.claude/settings.json`), then restart open chats. Daemon-spawned `sess_...`
sessions are unchanged, and the static URL is never overridden per chat.

### `hook install --host claude-desktop`

Writes the block above for you (including `SessionStart`, `Stop` and
`Notification`) plus the
[`pr-stamp`](#hook-pr-stamp) entry — a second `PostToolUse` hook with matcher
`Bash`. A file installed by an older version gains whichever of those it is
missing on the next run. It merges into the existing file (other keys,
other hooks and other env vars are kept), is idempotent (a second run changes
nothing), and refuses to touch a file it cannot parse. It no longer writes
`env.AGENTPROTO_SESSION_ID`; a legacy `claude-desktop` value is removed.

| Flag | Default | Description |
|------|---------|-------------|
| `--host <name>` | required | Only `claude-desktop` is supported. |
| `--session <id>` | ignored | Accepted for compatibility, but the printed MCP URL always carries `claude-desktop`; a non-empty value prints a one-line warning. Not written to `env`. |
| `--settings <path>` | `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR` honoured) | Settings file to merge into. |
| `--port <n>` | `18790` | Daemon port used in the printed MCP URL. |
| `--dry-run` | off | Print the merged settings JSON on stdout (and the target path and MCP URL on stderr); write nothing. |

The printed MCP URL is always
`http://127.0.0.1:<port>/mcp?callerSessionId=claude-desktop&host=claude-desktop`;
`--session` is ignored so every chat shares one identity.

It prints the `claude mcp add` line for step 1; registering the MCP URL stays
manual because Claude Code keeps MCP servers outside the settings file.

### Liveness of an `external` session

An `external` row idle past the liveness window (30 minutes by default) is
shown as `exited`, but it keeps accepting inbox delivery: nothing can restart
it, so events wait in the inbox until the next hook run, and any later MCP
request or inbox poll marks it `running` again. A row that was killed or
retired is refused. With `daemon.claudeSocketWake` enabled, a level 2+ message
that successfully wakes the process over its own unix socket is consumed
instead of parked, so the inbox hook will not deliver it a second time.

## `hook pr-stamp`

A Claude Code `PostToolUse` hook (matcher `Bash`) for sessions the daemon did
**not** spawn — a Claude Desktop Code tab, a plain `claude` CLI. When the tool
call was a successful `gh pr create`, it appends the `@agentproto-bot`
provenance footer (harness session id, host, cwd) to the created PR's body, so
an externally opened PR is stamped the way the daemon stamps its own. The hook
does the stamping; the model never has to.

It reads the hook payload on stdin and only acts on a Bash `gh pr create`
whose response printed a `https://github.com/<owner>/<repo>/pull/<n>` URL
(stdout first, so a PR url quoted on a warning is never the one edited). It
skips a daemon-spawned session (`AGENTPROTO_SESSION_ID` starting with
`sess_` — the daemon's own gh shim and reconciler stamp those with a richer
footer, and a thinner one landing first would block it), and never stamps a
body that already carries a provenance footer. Any failure (no `gh`,
unreadable PR, bad payload) is silent and exits `0`: a hook must never break
the session.

`hook install --host claude-desktop` wires it in; wire it by hand as a
matcher-`Bash` `PostToolUse` entry in the settings file if you are setting the
hooks up yourself.

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
