---
"@agentproto/driver-agent-cli": patch
"@agentproto/runtime": minor
---

F34b: exec a pinned `npx -y pkg@x.y.z` adapter's cached bin directly instead of paying `npm exec`'s tree scans and locks (fail-closed to a plain npx spawn otherwise), and mark a running workflow agent step whose session is still booting as `phase: "spawning"` in `workflow_status` until its session id attaches.
