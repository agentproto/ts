---
"@agentproto/runtime": patch
---

Fix PR provenance recording for shim-stamped footers: recognize and upgrade own-session footers from the `gh` PATH shim, enabling cost-refresh to find and enrich PRs opened via every adapter's wrapped `gh` subprocess.
