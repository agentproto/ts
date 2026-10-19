---
"@agentproto/runtime": patch
---

`allowPromptFrom` entries may now name callers by session label: `label:<exact label>` grants a caller whose registered label matches, and `label:<prefix>*` grants any caller whose label starts with the prefix. Covering this PR's runtime change; note the PR already ships `.changeset/prompt-allow-by-label.md` for the same package, and the review flags that mutable labels are a weak authorization key.
