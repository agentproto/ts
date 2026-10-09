---
"@agentproto/runtime": patch
---

Name the session in turn activity titles instead of its raw id. The activity feed now reads `Turn 3 completed on "Add VAT and discounts"` (session title, else label, truncated at 60 characters) rather than `Turn 3 completed on sess_a2916375`; a session with neither keeps the bare id. Activity ids, `sessionId` and `sourceRef` are unchanged.
