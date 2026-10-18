---
"@agentproto/cli": patch
---

fix(bootstrap): install.ps1 works on Windows 11/Server with npm 11 under a Restricted or AllSigned ExecutionPolicy — it always invokes the `.cmd` shims (never the blocked `.ps1`), allow-lists optional `node-pty` via `--allow-scripts`, and prints effective-policy-aware next-step guidance. feat(doctor): `preflight` now reports terminal sessions as a non-blocking warning when `node-pty` is not built, since its absence only disables PTY terminals and never agent sessions.
