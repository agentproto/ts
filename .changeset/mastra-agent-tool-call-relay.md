---
"@agentproto/adapter-mastra-agent": minor
---

Relay tool calls over ACP. The ACP host now drains Mastra's `fullStream` instead
of `textStream`, mapping `tool-call` → `tool_call` (status `in_progress`, with
kind/title/rawInput) and `tool-result` → `tool_call_update` (status
`completed`/`failed`, with rawOutput) alongside the text deltas. Hosts
(codex/claude-code/IDEs) now see the agent's live tool activity, not just the
final prose. `capabilities.tool_calls` is now `true`. A text-only fallback path
is kept for agents that expose only `textStream`.
