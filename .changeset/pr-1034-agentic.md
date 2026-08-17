---
"@agentproto/runtime": minor
---

Add daemon-side AGENTS.md resolution and injection (WP-R2) — the daemon now resolves the nearest AGENTS.md walking up from a session's cwd (bounded by git toplevel), injects it into the initial prompt (inline for small files, pointer for large ones), and stamps the resolution on the descriptor. Includes configurable inline/pointer threshold via config, dependency-injected fs for testability, and comprehensive unit + integration test coverage.
