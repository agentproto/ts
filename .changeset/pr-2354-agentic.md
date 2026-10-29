---
"@agentproto/runtime": patch
---

Read process start-time identity on macOS (via `ps -o lstart=`) so recorded app-service pids can be verified during boot reconcile instead of being signalled blindly, and fix the upload-path test to compare against the realpath-resolved temp directory on macOS.
