---
"@agentproto/apps": minor
"@agentproto/runtime": patch
"@agentproto/cli": patch
"agentproto-vscode": patch
---

Move five daemon-builtin panels (sessions-panel, agents-overview, bureau-sessions, session-story, live-session) from @agentproto/runtime into @agentproto/apps as house-app-quality code. Each panel exports a `make<Name>App(ops)` factory producing an AgnoMcpApp — the shape @agentproto/runtime's mcp-apps-adapter mounts directly at boot via the new builtin-apps.ts module. Panels are still unmounted at boot time with zero install step required; only where the code lives changed. Public tool ids, input schemas, resource URIs, and execute() behavior are byte-identical.
