---
"@agentproto/cli": minor
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Add queue management commands and MCP tools for prompt FIFO inspection and control.

Introduces `agentproto sessions queue <id>` CLI command with flags `--force`, `--deliver`, `--drop` to inspect and manipulate queued prompts after enqueue. Adds four new MCP tools (`session_queue_list`, `session_queue_promote`, `session_queue_deliver`, `session_queue_drop`) with the same semantics. HTTP routes mirror the MCP surface.

New public exports: `previewPrompt()`, `promptOriginLabel()`, `QueuedPromptView` interface from @agentproto/runtime for after-the-fact queue UI. Origin tracking distinguishes user-initiated queuing from agent/child-sourced prompts. Queue badge ("N queued") shown in CLI and VS Code session listings.

All three operations are deliberately distinct: promote reorders without interrupting; deliver interrupts and dispatches immediately; drop removes without delivering.
