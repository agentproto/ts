---
"@agentproto/runtime": patch
---

A prompt delivered by interrupting the in-flight turn (`session_queue_deliver` deliver-now, or `agent_prompt`/`sendPrompt` with `interrupt: true`) now opens with a one-line `[agentproto]` notice telling the model its previous turn was cut to deliver this message (naming the origin) and that it is NOT a stop request. Previously the model saw only a cancelled turn followed by a new prompt — indistinguishable from a human Esc — and a supervisor could park itself waiting for a go-ahead. A bare stop (`agent_interrupt`) adds no notice. The events-log `notice` is unchanged.
