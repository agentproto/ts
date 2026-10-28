---
"@agentproto/adapter-mastra-controller": minor
---

Run a live Mastra `AgentController` session from a `mastra.agent-controller/v1` manifest. `createAgentCliClient` now accepts a `manifest` option (env `AGENTPROTO_MASTRA_CONTROLLER_MANIFEST`), builds the controller via the new exported `createAgentControllerHost({ resolvers, defaults })`, opens a session in the requested mode (`connect({ mode })`, `controller_mode`, else the manifest default), and maps controller events to AIP-45 stream events. `cancel()` aborts the turn, `setSessionMode()` switches controller modes, controller-initiated switches surface as a `thought` notice, and the handle now claims `streaming`. Tool approvals and plan suspensions follow in E48 PR 3.
