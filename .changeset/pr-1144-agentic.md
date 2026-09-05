---
"@agentproto/runtime": minor
"@agentproto/workflow": minor
"@agentproto/workflow-loader": minor
"@agentproto/workflow-runtime": minor
---

Implement AIP-15 P2 (harness pinning) and P3 (declarative gate steps). 

**P2 Changes:**
- Add `AgentHarness` interface for spawn-time control (model, effort, role, tools, skills, cwd, promptFile)
- Thread harness fields through agent session spawn paths (host and sandbox)
- Emit `session:harness-warning` events when unsupported harness fields (tools, role) are encountered
- Load `harness.promptFile` at workflow-load time and record sha256 for audit

**P3 Changes:**
- Add `GateStep` interface for shell-command checks (command, args, cwd, report, retry, on_fail)
- Implement gate step execution with exit-code semantics, report parsing (JSON from stdout or file), and retry logic
- Add exponential/fixed backoff retry strategy with reprompt-and-retry linking to prior agent steps
- Emit `workflow:gate-report` events on every command attempt (not just final outcome)

All changes maintain backward compatibility (optional fields, new types only, no removals).
