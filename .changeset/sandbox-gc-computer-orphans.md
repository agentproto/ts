---
"@agentproto/runtime": minor
"@agentproto/sandbox": minor
"@agentproto/sandbox-computer": minor
"@agentproto/computer-api": minor
"@agentproto/cli": minor
---

Provider-control-plane orphan GC: `agentproto sandbox gc` and the new `sandbox_gc` MCP tool sweep a provider for boxes it still holds (and still charges RAM for) that the daemon's sandbox registry never knew and that no live session references, listing them (state, age, memory) and deleting them with `remove(..., { force: true })` only under `--apply` (dry run by default).

A candidate must be PAST A 15-MINUTE GRACE WINDOW (`ORPHAN_GRACE_MS`) and carry NO attached session (`sessions === 0`); the new `--include-attached` CLI flag (and the MCP tool's `includeAttached`) lifts the attached-session check explicitly. A box the provider does not date can never be proven stale and is never proposed. The shared gone-detection of the ledger gc (`GONE_RE`/`isGoneError`) now also decides "already disappeared" on the provider sweep, and a sweep that never ran (no daemon, no provider configured, no `listBoxes`) is reported as `not scanned` instead of "no orphan found".

Adds `SandboxProvider.listBoxes`/`SandboxProviderBox`, the computer provider's `GET /v1/computers` listing (`ComputerControllerClient.listComputers`), the `computerListEntrySchema`/`computerListResponseSchema` contract, and the `--provider` / `--include-attached` CLI flags. A box held by a live session is never a candidate and a failing provider is reported without stopping the sweep of the others.
