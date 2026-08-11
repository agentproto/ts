---
"@agentproto/adapter-mastra-agent": minor
---

Major architectural refactor: shift from raw stream-based event handling to Mastra's `AgentController` event subscription model. Adds comprehensive support for plan/build/review modes, tool approvals, daemon integration (sub-agent spawning, session notifications, state signals), and session resume. New public APIs: `promptContent` (multimodal prompt parsing), modes parsing and configuration, daemon client, signal provider, tool-approval and suspension bridges.
