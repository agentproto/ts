---
"@agentproto/driver-agent-cli": minor
"@agentproto/adapter-opencode": minor
---

opencode: pin `small_model` (session titles, summaries) to the session's own model. Without it opencode picked its own small model, GPT-5.4 Nano on OpenCode Zen, a paid model, so every `-free` session logged a rejected paid call per title. The pin goes into `OPENCODE_CONFIG_CONTENT` and is skipped when the inline config or the user's opencode config already sets `small_model`. The new `small_model` spawn option overrides it. Driver: new declarative `smallModel` adapter field.
