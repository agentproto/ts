---
"@agentproto/runtime": patch
---

Test gateways (`persist: false`) no longer read or write the user's real `~/.agentproto/tunnels.json`, no longer relaunch that file's autostart tunnels (which spawned real `cloudflared` processes with the test workspace as cwd — an orphaned-process leak), and persist tunnel state to `<workspace>/.agentproto/tunnels.json` instead. `TunnelRegistry.shutdown()` and the cloudflared providers now also stop a tunnel whose `start()` completes after the shutdown (SIGTERM, then SIGKILL after 3 s), instead of letting it come up and outlive the registry. A provider that reaps its own process after a mid-start `stop()` now throws the new exported `TunnelStartAbortedError`, which the registry settles as `stopped` (not `error`), so `autostart` tunnels caught mid-start by a restart are relaunched on the next boot.
