---
"@agentproto/runtime": patch
"@agentproto/driver-agent-cli": patch
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-hermes": patch
"@agentproto/cli": patch
---

Terminal restart fidelity: route-aware launch config, native terminal resume capability, and resume honesty.

- Extracts `buildRouteAwareLaunchConfig` so fresh spawn and restart inject `base_url` identically; derived-from-model adapters (e.g. hermes) no longer receive an unsupported `options.base_url`.
- Adds `capabilities.nativeTerminalResume` to the agent-cli manifest schema and stamps it on session descriptors; `pty-native` restart is now an explicit capability, not implied by ACP resumability.
- Preserves auth profile, route, model, posture, effort, and effective environment across restarts; wire model strips catalog `@route` suffixes and fixed-provider native vendor prefixes.
- Resume-honesty fix: adapters declaring `resumable: false` degrade to a flagged fresh spawn instead of a phantom ACP resume.
