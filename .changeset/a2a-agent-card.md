---
"@agentproto/a2a": minor
"@agentproto/runtime": patch
---

New `@agentproto/a2a` package: hand-written A2A (Agent2Agent, protocol 0.3.0) `AgentCard` types plus `buildAppAgentCard` / `buildDaemonAgentCard`. The runtime serves them at `GET /a2a/apps/:appId/.well-known/agent-card.json` (one card per installed app) and `GET /.well-known/agent-card.json` (daemon index aggregating every app that exposes something), behind the daemon's existing auth. Skills come only from an app's `exposes`; an app that declares none exposes nothing.
