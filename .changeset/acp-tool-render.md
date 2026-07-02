---
"@agentproto/acp": patch
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Render tool calls/results informatively instead of the generic `[tool] view` line. `translateSessionUpdate` now prefers a `tool_call`'s descriptive `title` over its coarse `kind` bucket, and folds `locations` into `arguments` when `rawInput` is absent so file paths survive downstream. `@agentproto/runtime` gains a `tool-presenter` (`formatToolCall`/`formatToolResult`) that sniffs salient args (path/command/pattern/url/description/…), special-cases control tools (`ScheduleWakeup`, `Task`, `TodoWrite`, `ExitPlanMode`), and summarizes results to one line — wired into the session ring buffer, `agentproto run`'s pretty printer, and the markdown transcript exporter. `AgentStreamEvent` gains `arguments`/`result` fields to carry the data through.
