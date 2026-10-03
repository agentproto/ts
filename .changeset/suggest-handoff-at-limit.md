---
"@agentproto/runtime": minor
---

Suggest a cross-harness handoff at the context or quota limit: `ask`-mode context questions gain `handoff:<harness>` options, a provider usage-limit error and the new `contextContinuity.handoffAtQuotaRemaining` threshold emit a `session:handoff-suggested` event with the `agentproto sessions handoff` command. Suggestions never switch harness on their own.
