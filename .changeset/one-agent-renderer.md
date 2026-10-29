---
"@agentproto/agent": minor
"@agentproto/manifest": minor
"@agentproto/app": patch
"@agentproto/skill": minor
---

AIP-42 `AgentEntry`, one AGENT.md renderer, and a configurable instructions composer.

- `@agentproto/agent` exports `AgentEntry { agent, body? }` and `renderAgentMd(entry)`, the single AGENT.md renderer. `agentVerbs` (create and update) and the app emitter both go through it, so the same agent renders to the same bytes on either path. The body is trimmed on render, so an update no longer grows blank lines.
- `defineAgent` refuses a missing or blank `model` with `model is required` (the generated schema types `model` as `any`, so a blank string used to pass).
- `composeInstructions(handle, body, opts?)` takes `boundariesHeader` and `sectionOrder`. The default boundaries header is now `Hard rules (these MUST be followed):`, without the em dash.
- `@agentproto/manifest`: `DoctypeSpec` gains an optional `render(handle, body)` hook that `create` and `update` use in place of the generic frontmatter renderer.
- `@agentproto/skill` exports `SkillEntry { skill, body }`.
- `@agentproto/app`: `renderAgentManifest` and `emitApp` delegate to `renderAgentMd`; ref comments cite AIP-54.
