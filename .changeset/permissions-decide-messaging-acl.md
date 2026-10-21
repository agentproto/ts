---
"@agentproto/runtime": minor
---

Add one permission decision point, `decide(principal, action, resource, context)` (exported as `decidePermission`), with the v1 action vocabulary (`session.message`, `session.message.interrupt`, `session.drive`, `session.spawn`, `command.exec`, and the rest as declared, not yet routed actions), and a read-only `permissions_explain` MCP tool that answers with the same function.

The messaging ACL is now one predicate for every entry point: `message_send` / `message_reply`, `message_parent`, `POST /sessions/:id/messages` and the box parent relay all call `decide()`, and `registry.sendMessage` refuses a message whose attached decision does not allow it. The HTTP route now resolves the caller like `/mcp` does (the `?callerSessionId=` query, else the trusted `x-agentproto-caller-session-id` header), honours `defaults.messaging.allowSiblings`, and grants interrupt to a session sender only under `defaults.messaging.agentInterrupt: "allow"`, matching the MCP tool. A caller with no session identity keeps operator rights: it can still message and interrupt any session.
