# `agentproto brain`

```text
agentproto brain query "<query>" [--workspace <slug|all>] [--topk <n>] [--json]
```

Fuzzy (BM25) keyword search over a workspace's **ingested session
transcripts** — the same engine the `workspace_brain_query` MCP tool
queries, reached over the daemon's `GET /brain/query` HTTP route so it
doesn't require an MCP client.

## Why this exists

The daemon's session brain (`workspace_brain_query` MCP tool) indexes
every ingested session transcript. Before this verb existed, that recall
was only reachable from an MCP-speaking client. This verb makes it a
plain CLI query — useful for "what did I do about X in some past
session?" without spinning up an agent.

Requires a running daemon — see [`serve.md`](./serve.md) /
[`daemon.md`](./daemon.md).

## `query "<query>"`

```bash
agentproto brain query "brain search design"
agentproto brain query "worktree gc" --workspace agentik-studio --topk 5
agentproto brain query "flaky test" --json
```

| Flag | Default | Description |
|------|---------|-------------|
| `<query>` | — | **Required.** Natural-language / keyword search string. |
| `--workspace <slug>` | `"all"` | Workspace bucket to search. `"all"` (default) federates every registered workspace brain plus the implicit `"default"` bucket; a named slug scopes the search to just that one brain. |
| `--topk <n>` | `10` | Max hits to return, `1..50`. |
| `--json` | off | Print the raw `{ workspace, hits }` JSON instead of the human table. |

Exit codes: `0` success, `1` no daemon found / request failed, `2`
missing `<query>` or an out-of-range `--topk`.

### Response shape

```json
{
  "workspace": "default",
  "hits": [
    {
      "sourceId": "sess-abc123",
      "sessionId": "sess-abc123",
      "title": "Brain search design",
      "score": 4.2,
      "snippet": "…decided to use BM25 for the brain…"
    }
  ]
}
```

`sessionId`/`title` are read from the ingested source's own metadata.
A source with no `sessionId` in its metadata (e.g. a knowledge-file
source, not a conversation) falls back to parsing the `sess-<id>` form
off `sourceId` instead of omitting it outright.

### Example output

```text
4.20  sess-abc123  Brain search design
    …decided to use BM25 for the brain…
```

## See also

- [`sessions.md`](./sessions.md) — the sessions this verb searches the
  transcripts of
- [`serve.md`](./serve.md) — the daemon that owns the `GET /brain/query`
  route this verb reads
