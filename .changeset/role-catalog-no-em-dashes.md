---
"@agentproto/role-catalog": patch
---

The seed roles no longer use an em dash as punctuation. Every seed body and handle field (description, mission, capabilities, anti-patterns) that used U+2014 now reads with a colon, comma or full stop, with the same meaning, lists and headings; `pack/` is regenerated to match. A new test fails when a seed body or handle string carries U+2014 or a spaced U+2013, so hosts that merge role text into generated manifests no longer need to normalize it.
