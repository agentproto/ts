---
"@agentproto/apps": patch
---

Port the command-result summary to the session-story panel: a command tool's
result is a JSON string with escaped newlines, which the panel's one-line
renderer truncated to the JSON preamble plus the first output line (usually
the cwd). Summarize the parsed stdout/stderr with the exit code instead, so
the panel matches `@agentproto/runtime`'s fixed presenter.
