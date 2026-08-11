---
"@agentproto/adapter-mastra-agent": patch
---

Fix a timing race condition in MastraAcpAgent.prompt() where Session.sendMessage may resolve before agent_end events are emitted on follow-up turns. The fix keeps the event subscription alive by waiting for agent_end explicitly, ensuring all events are captured.
