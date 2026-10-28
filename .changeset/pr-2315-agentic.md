---
"@agentproto/runtime": patch
---

Keep must-wake follow events (`awaiting-input`, `crashed`, and a `turn-end` carrying a question) visible through both follow-digest caps. Merge and render now drop non-must-wake entries first and count only those as omitted, and a later turn-end no longer collapses an earlier awaiting-input entry from the same session.
