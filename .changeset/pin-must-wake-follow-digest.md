---
"@agentproto/runtime": patch
---

Keep must-wake follow events (awaiting-input, crashed, and a turn-end carrying a question) visible through the digest caps. The merge and render caps drop non-must-wake entries first, and a later turn-end no longer collapses an earlier awaiting-input entry from the same session.
