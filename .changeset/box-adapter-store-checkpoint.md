---
"@agentproto/runtime": patch
---

A sandbox checkpoint now carries the adapter's own conversation store: the box's isolated adapter-config dir for this session is archived next to `checkpoint.json` as `adapter-store.tar.gz` (20 MiB cap, recorded on the checkpoint record, never failing the checkpoint), and a restart onto a FRESH box uploads and extracts it before the adapter starts — then passes the restored id through the box `agent_start`'s resume field so the conversation resumes natively instead of starting blank.
