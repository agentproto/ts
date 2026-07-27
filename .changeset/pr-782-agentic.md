---
"@agentproto/adapter-claude-sdk": patch
"@agentproto/adapter-mastra": patch
"@agentproto/adapter-mastra-agent": patch
"@agentproto/adapter-mastracode-inprocess": patch
"@agentproto/agencies": patch
"@agentproto/app-kit": patch
"@agentproto/apps": patch
"@agentproto/cli": patch
"@agentproto/corpus": patch
"@agentproto/governance": patch
"@agentproto/llm-endpoint": patch
"@agentproto/mastra": patch
"@agentproto/relay": patch
"@agentproto/rendezvous": patch
"@agentproto/runtime": patch
"@agentproto/sandbox-e2b": patch
"@agentproto/telemetry": patch
"@agentproto/workflow-mastra": patch
"agentproto-desktop": patch
"agentproto-vscode": patch
---

Weekly automated minor/patch dependency bump. Updates @anthropic-ai/claude-agent-sdk (0.3.200→0.3.220), @mastra dependencies (@mastra/core 1.32.1→1.52.1, @mastra/memory re-verified and raised to ^1.23.1), ws (unified 8.18.0/8.20.0 to 8.20.0, with 8.21.1 regression rolled back), and other standard updates (turbo, yaml, tsx, react, e2b, etc.). Build and tests pass. See PR description for detailed analysis of @mastra/memory ceiling justification and ws regression.
