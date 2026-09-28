---
"agentproto-vscode": minor
---

The Devices view now surfaces offline-host session snapshots: `DaemonClient.getDeviceSessions()` returns `{ sessions, stale?, capturedAt? }` instead of a bare session array, host rows render self-reported labels (`pr=…, repo=…`) in their detail line, and an expanded host whose sessions came from the daemon's last-known-good snapshot shows a "Host offline — last seen sessions (captured N ago)" banner instead of failing.
