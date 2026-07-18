# `agentproto conversation`

```text
agentproto conversation locate <sessionId>            [--json]
agentproto conversation locate <path/to/*.jsonl>       [--json]
```

Looks up the persisted link between an agentproto session and the
provider's own native conversation file — in either direction — by
scanning the workspace-bucket conversation index
(`~/.agentproto/workspaces/<slug>/conversations.jsonl`). Pure local
filesystem read: no daemon round-trip, works the same whether a daemon
is running or not (same category as [`worktree
ls`](./worktree.md#ls)).

## Why this exists

An agentproto session and the provider's own conversation (a claude-code
`.jsonl` under `~/.claude/projects/…`, or a hermes row in
`~/.hermes/state.db`) used to be linked only by RE-DERIVING the path on
every read from `cwd` + `adapterSessionId` — brittle (cwd drift, an
encoder bug that mishandled dotted paths) and blind to subagent
transcripts. The daemon now writes a small, append-only record of that
link at spawn, resume, and graceful-exit — this verb is the read side.

## `locate <sessionId | native-jsonl-path>`

```bash
agentproto conversation locate sess_ab12cd34
agentproto conversation locate ~/.claude/projects/-Users-me-app/11111111-....jsonl
agentproto conversation locate sess_ab12cd34 --json
```

Tries the argument as a **sessionId** first (forward: session →
native path + subagent transcripts). If nothing matches, retries it
as a **native jsonl path**, resolved against every recorded root
conversation path *and* every recorded subagent transcript path
(reverse: native file → owning session/workspace).

| Flag | Purpose |
|------|---------|
| `--json` | Emit the located record as JSON (`{ workspace, record, matchedSubagentPath?, matchedBy }`) instead of the human-readable summary. |

Exit codes: `0` found, `1` no record matches either direction, `2`
missing argument / usage error.

### Example output

```text
Session:    sess_ab12cd34
Workspace:  my-app
Adapter:    claude-code (11111111-0000-0000-0000-000000000001)
cwd:        /Users/me/code/my-app
Native:     claude-jsonl
  path:       /Users/me/.claude/projects/-Users-me-code-my-app/11111111-....jsonl
  subagents:  1
    - /Users/me/.claude/projects/-Users-me-code-my-app/11111111-.../subagents/agent-ae03cafe.jsonl
Transcript: /Users/me/.agentproto/sessions/sess_ab12cd34/events.jsonl
Started:    2026-07-18T10:00:00.000Z
```

A hermes-backed session's `Native:` block shows `hermes-sqlite` with
`dbPath`/`rowId` instead of a `path`/`subagents` pair — hermes keeps
one shared sqlite db, not a per-conversation file, so there is nothing
to reverse-lookup a path against for that adapter.

## See also

- [Session transcripts](../concepts/session-transcripts.md) — what
  `agentprotoTranscript` points at and how it differs from the native
  store
- [`sessions.md`](./sessions.md#export-id-or-name) — `sessions export`
  reads the SAME native/daemon sources this verb only locates
- [`worktree.md`](./worktree.md) — the other purely-local, no-daemon
  verb family
