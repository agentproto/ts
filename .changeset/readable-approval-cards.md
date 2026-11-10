---
"@agentproto/runtime": patch
---

The Telegram approval card reads the `{ summary, sections, links }` preview convention the approval page already renders: the summary, each section as a title and its text (the remaining space split fairly, so a long cover letter no longer pushes out a short section), and `https:` links, as plain text instead of a clipped JSON blob. A preview without those keys renders as before. Bureau recipe-write approvals now fill `summary` and a `What will change` section, keeping every existing preview key; the payload and `inputSha256` are untouched.
