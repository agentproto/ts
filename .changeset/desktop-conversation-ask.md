---
"@agentproto/runtime": minor
---

New MCP tool `desktop_conversation_ask { app: "claude", id, text, urgency?, waitMs? }`: sends a message to a Claude Desktop conversation listed by `desktop_conversation_list` (registering its `cc:<id>` external row) and waits for its answer in the transcript. Delivery is the daemon's existing external path: a direct wake over the chat's Claude Code socket when `daemon.claudeSocketWake` is on, else the chat's inbox (reported as `delivered.via`, no reply).

The send goes through the same path as `message_send` (`registerMessageTools` now returns `sendAsCaller`): same caller resolution, permission decision and `noCallerIdentity` policy, so a refusal sends nothing and is surfaced.

Because that path is a permission decision, the chat's external row is stamped with the workspace slug resolved from its `cwd` (a new optional `workspaceSlug` on `SessionsRegistry.touchExternal`), so the default same-workspace rule binds. A **session** caller whose workspace is not the chat's is still refused with `forbidden_recipient` unless a `defaults.messaging` grant, peer group, or `peerBinding: "verified"` allows it; the refusal text names the requirement, and `permissions_explain` answers why. Operator/root callers are unaffected.
