---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Fix `agentproto app install <dir>` writing a bare `{appId, dir, dataDir}` registry record that made every `workflow_run_file` fail after a daemon restart (`Cannot read properties of undefined (reading 'some')`). The CLI now installs through the daemon's `app_install` when it is reachable and, when it is not, runs the same `performInstall` in-process (new `@agentproto/runtime/app-install-offline`), so both paths write the identical full record; an app that does not load is rejected instead of registered. The registry reader also tolerates partial or legacy records: missing `agents`/`workflows`/`unvalidatedAgentTools` are defaulted on load, unusable records (no `appId`/`dir`) are skipped, the daemon re-resolves partial records from their app dir in the background, and what was found is reported via `app_list` (`registryProblems`) and `daemon_health`/`/health` (`appRegistryIssues`) rather than thrown.
