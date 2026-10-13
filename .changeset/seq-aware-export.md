---
"@agentproto/runtime": patch
---

Seq-aware transcript export and checkpoint cutoff: `ExportedMessage.seq` carries the `events.jsonl` seq of the record that started the message (a batched assistant turn carries its first record's seq), `exportDaemonEventsSession` takes an `untilSeq` option that skips records past the cutoff so a transcript can be cut at a message boundary, and `splitMessagesAtSeq` splits an exported message list into head/tail at a cutoff. `buildContextCheckpoint` takes the same `untilSeq`, passes it through to the export, and records it as `cutoffSeq` on the checkpoint (`checkpoint-schema.ts` / `schemas/checkpoint.v1.json` updated).
