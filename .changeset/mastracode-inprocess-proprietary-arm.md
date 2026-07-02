---
"@agentproto/adapter-mastracode-inprocess": minor
"@agentproto/driver-agent-cli": minor
"@agentproto/cli": patch
---

Implement the AIP-45 `protocol: "proprietary"` arm end to end: `createProprietaryProtocolArm` now dynamic-loads an adapter's `createAgentCliClient` factory and `createAgentCliRuntime` skips the subprocess spawn for it. Ship `@agentproto/adapter-mastracode-inprocess`, a new adapter driving Mastra Code in-process via its SDK (`createMastraCode` + `runMC`) instead of spawning the CLI, with a composite `resourceId:threadId` session id that verifiably survives a process restart. Register the new `mastracode-inprocess` slug in the CLI's adapter catalog.

Fix `resolveAdapter` to rewrite a `protocol: "proprietary"` handle's `adapter` field to a fully-resolved absolute path before handing it off — `createProprietaryProtocolArm` re-imports that field a second time from `@agentproto/driver-agent-cli`'s own module location (which deliberately depends on no specific adapter), so a bare package-name specifier that resolved fine during discovery could fail to resolve at session-start. Applies to every proprietary adapter, not just this one.
