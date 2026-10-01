---
"@agentproto/runtime": patch
"@agentproto/harness": patch
---

Device spawn must name where to land: an `agent_start({ sandbox: "device:<fp>" })` with neither `cwd` nor `workspaceSlug` now fails 4xx with `device_spawn_requires_repo_identity` (issue #1647 field report — it used to silently land in the target daemon's active workspace, wrong files/wrong AGENTS.md). An explicit `workspaceSlug` on a device spawn is forwarded over the bridge (marked `deviceBridge: true`) so the TARGET daemon resolves it against its own registry: there it fails 4xx with `device_bridge_workspace_unknown` naming the slug and the target's known slugs instead of falling back to the active workspace. Local spawn semantics are unchanged. `adapter_not_found` for a route-like slug (e.g. `opencode-go`) is now actionable — it names the corrective `adapter`/`model`/`route` usage. `StartAgentArgs` gains the internal `deviceBridge` bridge marker.
