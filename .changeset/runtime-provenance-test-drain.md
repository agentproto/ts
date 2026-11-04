---
"@agentproto/runtime": patch
---

Test only: `command-list-provenance.test.ts` drains the registry's pending writes before deleting its temp dir, so the fire-and-forget command-log write no longer logs an ENOENT on CI.
