---
"@agentproto/adapter-code-brain-gbrain": patch
"@agentproto/adapter-hermes": patch
"@agentproto/adapter-knowledge-corpus": patch
"@agentproto/adapter-mastra-controller": patch
"@agentproto/adapter-opencode": patch
"@agentproto/acp": patch
"@agentproto/agencies-engine": patch
"@agentproto/app": patch
"@agentproto/apps": patch
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

Breaking renames: the vendor auth builtin export is now `acmeAuthProvider` (provider id `acme`, API base `https://api.example.com`, keychain ref `bureau-acme`), so hosts must register their own provider through the manifest seam; the legacy role map export of `@agentproto/role-catalog` is now `LEGACY_ACME_ROLE_MAP`. The session-steward origin policy matches `orchestrator` roots instead of the previous product label. The private Replicate fine-tune entry is dropped from the model catalog.
