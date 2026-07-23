---
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

Harden daemon lifecycle for idempotent startup under launchd supervision:

- **KeepAlive crash-only restart**: Changed plist `KeepAlive` from always-restart (`<true/>`) to crash-only (`<dict><SuccessfulExit>false</SuccessfulExit></dict>`). This allows clean exit-0 to stay settled, enabling idempotent `serve` startup when a healthy daemon already owns the port.

- **Split `daemon start` into idempotent-launch vs force-cycle**: 
  - `agentproto daemon start` now uses `kickstart` (no `-k`): idempotent, leaves a healthy daemon running.
  - `agentproto daemon restart` uses `kickstart -k`: force-cycle, kills and relaunches (replaces `pnpm killport 18790`).

- **Idempotent gateway boot**: `serve` now preflights the `/health` endpoint before binding. If a healthy daemon already owns the port, exits cleanly with exit-0. If bind races, re-probes on EADDRINUSE and defers to the winner.

- **Rate-limited reconnect logging**: New `createReconnectLogGate` (exported from `@agentproto/runtime`) rate-limits failure logging per key. A dead peer's standing reconnect loop logs the first failure immediately, then at most one line per window with a suppressed-count suffix. Fixes log spam: one dead pairing previously buried 85% of `daemon.log`.

- **Test coverage**: New comprehensive tests for daemon lifecycle (`daemon-lifecycle.test.ts`), idempotent boot (`serve-idempotent-boot.test.ts`), and log rate-limiting (`reconnect-log-gate.test.ts`).
