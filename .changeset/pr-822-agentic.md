---
"@agentproto/runtime": minor
"@agentproto/workflow-runtime": minor
---

**Feature: Agent step output text threading in workflows**

Agent steps can now automatically capture their text output and inject it into subsequent steps' prompts, enabling multi-step workflows to share context and analysis. The workflow runtime captures the final message from each agent step (when `readFinalMessage` is available) and threads it through the bindings, making it accessible to downstream steps via the AIP-16 Selector pattern. Previous step outputs are formatted as `[Output from step "id"]\ntext` and prepended to the base prompt, improving agent reasoning across sequential steps.
