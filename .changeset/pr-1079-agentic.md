---
"@agentproto/corpus": minor
---

Improve applyEdits edit safety: check each edit individually and surface pre-existing defects.

Previously, if any edit failed post-check (introducing an out-of-range cite or breaking the heading), the entire batch would be reverted silently. Now:

- Each edit is post-checked individually: a bad edit reverts itself, not the whole chapter
- Pre-existing defects (e.g., a writer-introduced stray `[0]` citation) no longer block valid edits from landing
- Contextual checking: replacements are checked both in isolation and in context (composing with surrounding text)
- New field in stats: `preExistingOutOfRange` surfaces defects that pre-existed the edits

This enables better resilience: valid edits always land even when the chapter carries pre-existing citation defects, and the draft defects are surfaced in the report rather than silently reverted.
