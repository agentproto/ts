---
"@agentproto/adapter-mastracode": patch
"@agentproto/driver-agent-cli": patch
---

Fix the mastracode print arm: the manifest declared `--output-format stream-json`, a flag mastracode 0.27 silently ignores, so every turn fell back to human-readable text that the JSON-line parser then discarded — the adapter always returned empty output. Switch to the real `--output jsonl` flag, capture the thread id from the stream's authoritative final `result` line instead of the incidental (OM-gated) `om_status` event, and mark `capabilities.resumable: true` with `native-resume` in `continuation.supported` now that `--thread <id>` is confirmed to actually rehydrate a prior thread's memory across process spawns.
