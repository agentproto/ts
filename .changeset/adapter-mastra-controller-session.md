---
"@agentproto/adapter-mastra-controller": minor
---

Run a Mastra AgentController session with its modes. `createAgentCliClient` now reads the manifest named by the new `manifest` option, builds the controller through `createAgentControllerHost({ resolvers, defaults })`, opens a session in the requested mode (`connect({ mode })`, the new `controller_mode` option, else the manifest default) and maps controller events to AIP-45 stream events through `mapMastraEvent`. `cancel()` ends the turn as `cancelled`, `setSessionMode()` switches the controller mode, and a mode switch the controller makes by itself surfaces as a `thought` notice. An unregistered `$resolver` fails with `UnresolvedReferenceError` naming the field path. The handle now claims `streaming`; tool approvals and plan suspensions follow in the next release.
