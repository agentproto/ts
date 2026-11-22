---
"@agentproto/adapter-code-brain-gbrain": patch
"@agentproto/adapter-hermes": patch
"@agentproto/adapter-knowledge-corpus": patch
"@agentproto/adapter-mastra-controller": patch
"@agentproto/adapter-opencode": patch
"@agentproto/acp": patch
"@agentproto/agencies-engine": patch
"@agentproto/app": patch
"@agentproto/apps": minor
"@agentproto/auth": major
"@agentproto/billing": patch
"@agentproto/bridge": patch
"@agentproto/browser-profiles": patch
"@agentproto/cli": patch
"@agentproto/connector": patch
"@agentproto/corpus-cli": patch
"@agentproto/corpus": patch
"@agentproto/egress": patch
"@agentproto/governance": patch
"@agentproto/harness": patch
"@agentproto/knowledge-cascade": patch
"@agentproto/knowledge-engine": patch
"@agentproto/model-catalog": patch
"@agentproto/office": patch
"@agentproto/role-catalog": major
"@agentproto/role": patch
"@agentproto/runtime": patch
"@agentproto/sandbox": patch
"@agentproto/secrets": patch
"@agentproto/skill-pack-agentproto": patch
"@agentproto/storage": patch
"@agentproto/transcript-fixtures": patch
"@agentproto/voice-elevenlabs": patch
"@agentproto/voice-gemini": patch
"@agentproto/voice-openai": patch
"@agentproto/wallet": patch
"@agentproto/workspace-brain": patch
"@agentproto/workspace": patch
"@agentproto/worktree": patch
"@agentproto/assembly": patch
"@agentproto/memory": patch
---

Remove private product and repository names from comments, docs, examples and tests.

`@agentproto/auth` no longer ships a vendor provider: the `acmeAuthProvider`-style builtin export is removed and `BUILTIN_AUTH_PROVIDERS` is empty, so the registry starts empty. A host declares its own provider with `parseAuthProviderManifest` (or `defineAuthProvider`) and `registerAuthProvider`, which already existed. Breaking for code that imported the old export or looked the old id up without registering it.

`@agentproto/role-catalog`: the legacy role map export is now `LEGACY_OPERATOR_ROLE_MAP`.

`@agentproto/apps` (session-steward): new `extraClosableOrigins` input appended to the closable origin list in force. The generic default roots are `orchestrator` and `orchestrator:*`; a host that stamps its own root label adds it with `extraClosableOrigins`.

The private Replicate fine-tune entry is dropped from the model catalog.
