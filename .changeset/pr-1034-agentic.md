---
"@agentproto/runtime": minor
---

Add daemon-side AGENTS.md resolution and injection (WP-R2) + role disposition SYSTEM preamble tagging (WP-R3). The daemon now resolves the nearest AGENTS.md walking up from a session's cwd (bounded by git toplevel), injects it into the initial prompt (inline for small files, pointer for large ones), and stamps the resolution on the descriptor. Role disposition text has been clarified and is now recorded separately as a SYSTEM preamble in transcripts (along with lineage and AGENTS.md pointer), allowing UIs to fold synthesized text instead of rendering it as user bubbles. Includes configurable inline/pointer threshold via config, dependency-injected fs for testability, and comprehensive unit + integration test coverage.
