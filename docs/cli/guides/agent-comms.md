# Message between agentproto sessions and Claude Code or Desktop sessions

Status: Experimental

How a daemon session, a Claude Code session and a Claude Desktop chat send
messages to each other, and what it takes to wake an idle Claude Code session.

## Who is who

- Daemon sessions: `sess_xxxx`.
- Claude Code sessions: `cc:<session_id>` (rows created by the hooks, `agentproto hook inbox`).
- Claude Desktop MCP entries share one unverified identity, `claude-desktop`.

## Send a message

- Child to its supervisor: `message_parent`. A supervisor that must be woken is
  declared at spawn with `agent_start parent: "cc:<your session id>"` (no
  `attach: false`, which makes the child an independent root). `parent` is for a
  caller the daemon cannot identify (Claude Code on a static MCP URL, or the
  shared `claude-desktop` identity); a call that already carries an identity
  attaches under it automatically. The parent is declared, not proven: same
  trust as `replyTo`.
- Driving a child from Claude Desktop: a child spawned with `parent: "cc:<id>"`
  through the `claude-desktop` identity is owned by that `cc:` row, which a
  Desktop call cannot present (it arrives as `claude-desktop`). So the daemon
  records `allowPromptFrom: ["claude-desktop"]` on such a child by default, and
  `agent_prompt`, `agent_interrupt`, `agent_kill`, `session_restart` and
  `session_continue_fresh` work from the Desktop chat. Pass your own
  `allowPromptFrom` to replace it, or `allowPromptFrom: []` to keep the child
  owner-only. Verified identities and identity-less callers get no such grant.
- Any session to any session: `message_send to: "<sess_xxxx | cc:<id>>"`.
- Urgency:

| Urgency | Effect |
|---------|--------|
| `fyi` | never wakes |
| `next-turn` | queues behind the current turn |
| `steer` | injects into the running turn |
| `interrupt` | only if the operator allows it, otherwise `steer` |

The result of `message_send` and `message_parent` carries
`wake: { written, reason, hint? }` when the socket wake is enabled (see below).
Read it: `written: true` with `reason: "held-by-receiver-bypass"` means the
message is parked, not delivered.

## What wakes an idle Claude Code session

The socket wake writes a frame on `/tmp/cc-socks/<pid>.sock`. It is off by
default: turn it on with `agentproto config set daemon.claudeSocketWake true`
(applied on daemon restart). It only writes for `next-turn`, `steer` and
`interrupt`; an `fyi` is parked in the inbox.

Claude Code accepts the frame depending on the receiver's permission mode:

| Receiver mode | Wakes? | Needs |
|---------------|--------|-------|
| default, acceptEdits, auto | yes | nothing |
| bypassPermissions | only with `crossSessionInbound: "accept"` | the setting below |

Without the setting a bypass receiver holds the frame (cause `no-mode-asserted`:
the frame carries no permission class). The daemon also parks a copy in the
receiver's inbox, so it shows at the next prompt. If Claude Code later releases
its held copy, the receiver may see the message twice.

## Fix for bypass receivers

```bash
agentproto doctor --fix
```

Adds `"crossSessionInbound": "accept"` to `~/.claude/settings.json` (backup,
atomic write, other keys kept, diff printed, no-op if already set). The daemon
never writes that file. Restart the receiver session if it does not wake after
the change (whether a running session picks it up is not proven).

## When it does not work

1. Look at the `wake` object in the send result and the daemon log line
   `[socket-wake] to= written= reason= pid= rowMode=`. No `wake` object means
   the socket wake is off.
2. `agentproto doctor` shows the `daemon.wake` check; `daemon_health` lists one
   warning per held receiver.
3. `no-registration` or `no-socket`: the receiver is not a live Claude Code
   session (wrong id, or it exited). `urgency`: an `fyi` never wakes, by design.
4. Desktop sessions: the env-var attestation cannot work (Desktop does not set
   `CLAUDE_CODE_SESSION_ID` for MCP servers); use the declared parent.

## Test recipe

Start a throwaway receiver in a terminal tab (`agentproto` must be on `PATH`):

```bash
claude --permission-mode bypassPermissions "Reply READY, then wait."
```

Then send `message_send to: "cc:<its session id>" urgency: "next-turn"` and
watch it answer. The session id is in `~/.claude/sessions/<pid>.json` (never
print the `.key` files).

## See also

- [signals-and-wake](./signals-and-wake.md): get woken by session lifecycle and PR signals without polling, and how signal routing picks a provider
