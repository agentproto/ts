---
"@agentproto/runtime": minor
"agentproto-vscode": patch
---

The runtime adds a pageable `adapter_models` MCP tool and an `adapter` filter on `adapter_list`, and its compact `adapter_list` projection now surfaces each adapter's exact `status`, picker `hint`, and `modes` (id/status/status_note) so list-only clients can render readiness without a `full` round-trip; `AdapterListEntry` is typed with the optional `modelDetails` rows.

`agentproto-vscode` consumes those compact rows in the Harnesses tree, pages per-adapter model detail, and narrows the legacy-daemon fallback to genuine unknown-tool/method errors so a tool-level "adapter … was not found" is no longer misread as a missing tool.
