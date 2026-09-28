---
"@agentproto/sandbox": minor
"@agentproto/runtime": minor
---

Auto-join wiring for sandbox boxes: optional `join: { tokenEnv: string }` on the AIP-36 `SandboxDefinition` (`@agentproto/sandbox`) names a host env var whose value (a join-token URL) is forwarded into the box under the same name at boot — sugar over `env.passthrough`, self-documenting for the auto-join case, and a no-op (never a boot failure) when the named host env var isn't actually set. `@agentproto/runtime`'s sandbox-boot slug collection (`bootSandboxAgentSession`) now includes `join.tokenEnv` in the resolved secret set whenever it's present and resolvable.
