---
"@agentproto/runtime": minor
"@agentproto/sandbox": minor
"@agentproto/sandbox-computer": minor
"@agentproto/computer-api": minor
"@agentproto/cli": minor
---

Provider-control-plane orphan GC: `agentproto sandbox gc` and the new `sandbox_gc` MCP tool sweep a provider for boxes it still holds that the daemon's sandbox registry never knew and no live session references, listing them (state, age, memory) and deleting them with `remove(..., { force: true })` only under `--apply` (dry run by default). Adds `SandboxProvider.listBoxes`/`SandboxProviderBox`, the computer provider's `GET /v1/computers` listing (`ComputerControllerClient.listComputers`), the `computerListEntrySchema`/`computerListResponseSchema` contract, and the `--provider` CLI flag. A box held by a live session is never a candidate and a failing provider is reported without stopping the sweep of the others.

Note: the PR already carries an equivalent (patch-level) changeset, `.changeset/sandbox-gc-computer-orphans.md`; this file is the reviewer handoff and uses minor for the new public API per `VERSIONING.md`.
