---
"@agentproto/runtime": patch
---

`app_install` now accepts a published catalog entry's `source` as is. The descriptors a catalog source carries next to the install fields (`kind`, `version`, `size`) are dropped by one shared step in the input schema (and in the panel dispatcher), so any store client can confirm an install without hitting the "pass exactly one source" error.
