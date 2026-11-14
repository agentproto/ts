---
"@agentproto/routine": major
"@agentproto/harness": major
"@agentproto/sandbox": major
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/adapter-pi": minor
"@agentproto/adapter-mastra-controller": minor
"@agentproto/adapter-mastracode-inprocess": minor
---

Follow the AIP-36, 41 and 45 rename of `adapter` to `harness`. Manifests accept only the canonical keys, with no alias and no deprecation period.

Major for `@agentproto/routine`, `@agentproto/harness` and `@agentproto/sandbox`, because the shape they accept breaks: a manifest that was valid before is now rejected.

- `@agentproto/routine`: a ROUTINE.md `target.agent` requires `harness`. `target.agent.adapter` is rejected with an error that names `target.agent.harness`. `TargetAgent.agent.adapter` becomes `harness`. A failing `target` now reports the arm the author meant instead of a bare "Invalid input".
- `@agentproto/harness`: a HARNESS.md takes the root `harness` field (required when `protocol: proprietary`). The root `adapter` is rejected with an error that names `harness`. `AgentCliDefinition.adapter` becomes `harness`.
- `@agentproto/sandbox`: `SandboxDefinition.config` takes `installHarnesses`. `defineSandbox` and `parseSandboxManifest` reject `config.installAdapters` with an error that names `installHarnesses` (`renamedSandboxKeyError`, `INSTALL_ADAPTERS_RENAMED`).
- `@agentproto/runtime`: a sandbox spawn installs `config.installHarnesses`. Before, a canonical spec validated and then installed nothing. A spec still carrying `config.installAdapters` now fails with `sandbox_spec_invalid` before any box boots. Routine targets reach `agent_start` with `harness`.
- `@agentproto/cli`: the registry resolver rewrites a proprietary handle's `harness` to its resolved path.
- `@agentproto/adapter-pi`, `@agentproto/adapter-mastra-controller`, `@agentproto/adapter-mastracode-inprocess`: their manifests declare `harness` instead of `adapter`.
