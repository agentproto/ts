---
"@agentproto/runtime": patch
---

A prompt delivered by interrupting the running turn (`session_queue_deliver` deliver-now, `agent_prompt {interrupt: true}`, an `interrupt`-urgency message) now reaches the model prefixed with a system line saying the previous turn was cut to deliver it, from whom, and that it is not a stop request. Before, the model only saw its turn cancelled and a new prompt, which it could not tell apart from a human pressing Stop; a supervisor read a child's delivered report that way and parked itself waiting for a go-ahead. The line is recorded as a `system-prompt` slice, so transcripts still show the caller's own text. A deliver-now message turn is now recorded with `via: "interrupt"`.
