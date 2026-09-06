---
"@agentproto/runtime": minor
---

Compact-by-default tool output (MCP-pagination PR-10): `session_list` now
returns a slim per-item projection by default (id/kind/name/label/status/
pty/command/cwd/adapterSlug/model/busy/awaitingInput/blockedOn/
lastActivityAt/startedAt/exitCode/depth/parentSessionId) — pass
`full: true` or `compact: false` for the complete descriptor.
`tool_calls_list` defaults to the result-preview posture (~500-char
`result` truncation); `full: true` restores unfiltered records.
`terminal_output` caps its read at the last 4096 bytes when `lastBytes`
is omitted (explicit `lastBytes`, up to 65536, is unchanged). Additionally,
the shared pagination envelope's `fields` param is now honored generically:
every `paginate`/`toolText` list tool applies an explicit `fields`
allowlist per item when supplied (previously accepted but ignored).
