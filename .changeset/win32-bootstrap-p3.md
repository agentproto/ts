---
"@agentproto/runtime": patch
"@agentproto/cli": patch
"@agentproto/driver-agent-cli": patch
---

win32 field fixes (BOOTSTRAP P3, reproduced 2026-09-30 on Windows 11 / Node 26.10.0)

- `driver-agent-cli`: `resolveWindowsBatchSpawn` now probes for the npm shim's real
  node entry with the actual filesystem when called without injected deps. The
  shipped dist evaluated a placeholder `() => false`, so the stage-1 rewrite never
  returned and every `bin: "npx"` spawn fell to `shell: true` — where cmd.exe
  mangled the quoted `C:\Program Files\nodejs\...` path, every `agent_start`
  failed with "ACP connection closed", the VS Code terminal with "pty failed to
  spawn", and chat with HTTP 500. Regression-tested against a real fs fixture
  under a path containing a space.
- `cli`: the scheduled-task launcher `~/.agentproto/agentproto-daemon.cmd` now
  starts with `cd /d` to the configured `daemon.workspace` (otherwise
  `%USERPROFILE%`). The task used to run from `C:\Windows\System32`, where the
  daemon died EPERM creating `.agentproto/runtime.json`. `agentproto daemon stop`
  no longer trusts `schtasks /End` alone: it probes `/health`, and when the port
  still answers kills the recorded PID tree (`taskkill /PID <pid> /T /F`) and
  re-probes — the node child used to keep listening, so a later `start` reused a
  zombie daemon and new code never loaded.
- `runtime`: after 5 consecutive failed host dials the controller logs the
  one-line remediation "host handshake failing — the controller should re-run
  `agentproto devices add` with a fresh `pair offer --host`" (classically: a
  Windows reboot invalidated the old host registration and nothing in the log
  pointed at the fix). `agentproto doctor`'s devices check flags a host whose
  channel is failing its handshake recently and prints the same hint. No
  pairing-protocol change.
