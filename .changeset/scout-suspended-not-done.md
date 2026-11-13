---
"@agentproto/adapter-mastra-agent": minor
"@agentproto/runtime": patch
"@agentproto/workflow-runtime": patch
---

A workflow agent step parked on an approval now fails instead of reporting `done`: a step with no `policy` defaults to `{ awaiting: "fail" }` at run time, and `onAwaitingInput` fails on a pending permission request or on the mastra-agent "run suspended" note. The mastra-agent adapter runs an AGENT.md with `autonomy: 10` as one mode with no plan gate and no tool approvals (it keeps the daemon and MCP toolsets), so an unattended step such as scout-run can run.
