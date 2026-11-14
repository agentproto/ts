---
"@agentproto/sandbox-computer": patch
---

Collect a bounded, redacted in-box diagnostic snapshot (`ip -br addr`, `ip route`, `/etc/resolv.conf`, `getent hosts registry.npmjs.org`, the last 40 lines of the daemon log, and the agentproto process table) when a computer reached running but the daemon never became healthy or attach failed, before the box is destroyed. The snapshot rides the thrown error as `bootDiagnostics` and is appended to its message and the boot log, so a boot failure with `egressIp` set is diagnosable after teardown.
