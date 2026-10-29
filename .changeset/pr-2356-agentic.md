---
"@agentproto/runtime": patch
---

Turn retry now treats an upstream capacity refusal (`[ttft_admission_refused]` / "at capacity; retry shortly") as a transient `upstream-5xx` error, so an executor re-prompts instead of ending the turn empty, honours the provider's `(after N s)` delay hint (capped at `maxDelayMs`) on 5xx errors too, and the `[warning] empty turn` line names the provider error instead of guessing an invalid model id when the turn ended on a provider failure.
