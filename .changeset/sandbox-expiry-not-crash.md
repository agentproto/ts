---
"@agentproto/runtime": patch
"@agentproto/sandbox-e2b": patch
---

Sandbox sessions whose box reaches its lifetime deadline (e2b plan cap: 1h of continuous run on Hobby/Base, active or not) now end cleanly as `endedReason: "sandbox-expired"` / `status: "exited"` instead of being classified `crashed` / `error` without an artifact. The watchdog tags a death at/past the known (renewal-pushed) deadline as expected expiry (`SandboxBoxExpiredError`), the registry ends the row through a new `markSandboxExpired` (same lazy-resumable cleanup as a crash, but no crash status and no restart policy match), and the derived outcome surfaces the delivered work branch as a `type: "branch"` artifact. The e2b provider documents the real root cause of the "active session dies at start+~60min" reports: the plan's total continuous-run window — heartbeat renewal already works and cannot extend past it (Pro plan or e2b pause/resume is the escape hatch).
