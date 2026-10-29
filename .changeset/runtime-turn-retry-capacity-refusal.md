---
"@agentproto/runtime": patch
---

Turn retry now treats an upstream capacity refusal as transient. OpenCode Go's `[ttft_admission_refused] the cell is at capacity; retry shortly (after 8 s)` (and other "at capacity" / "over capacity" / "retry shortly" refusals) is classified `upstream-5xx` instead of `other`, so an executor re-prompts instead of ending the turn empty, and the `(after N s)` hint is read as the backoff, capped at `maxDelayMs`. A retry-after hint is now honoured on `upstream-5xx` errors too, not only on rate limits. The `[warning] empty turn` line no longer suggests an invalid model id when the turn ended on a provider error: it names that error, and says when it is transient.
