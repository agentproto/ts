---
"@agentproto/runtime": patch
---

Host snapshot: merge captures instead of replacing — an empty session list
from a finished host no longer wipes the prior snapshot. Sessions missing
from the new list are kept as `status: "gone"` with their captured output
tails intact, so a CI runner's review history survives its teardown capture.
Merged lists stay capped (20 rows, newest first, 256 KiB).
