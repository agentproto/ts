---
"@agentproto/runtime": patch
---

Summarize a command tool's result from its real stdout/stderr instead of the
raw JSON blob. `command_execute` returns its result as one JSON string
(`{exitCode,stdout,stderr}`), whose newlines are escaped — so the one-line
renderer saw a single "line" and truncated it to the first ~160 chars, showing
the JSON preamble plus the first thing the command printed (often the cwd).
The presenter now detects that shape, parses it, and reports the exit code and
the real line/byte count of the output.
