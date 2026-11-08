---
"@agentproto/command-sandbox": minor
"@agentproto/harness": patch
"@agentproto/runtime": minor
---

The operator can now grant an installed app READ-ONLY access to paths outside its folder with `apps.readGrants` (`{ "<appId>": ["/abs/path"] }`) in `~/.agentproto/config.json`. The grant is hand-edit only (`config_set` refuses it), read at daemon boot, validated (existing absolute path; `/`, `$HOME`, `~/.ssh`, `~/.aws`, `~/.config`, keychains, `.env` files and the daemon workspace are refused) and logged; `app_list` shows `operatorReadGrants`. It is never read from the app manifest, so an app cannot grant itself anything. Secret files inside a granted tree are masked through a new `SandboxZones.unreadable` zone (Seatbelt deny emitted last, bubblewrap `/dev/null` or tmpfs overlay). With no grant, behavior is unchanged.
