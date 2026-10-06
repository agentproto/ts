---
"@agentproto/secrets": minor
"@agentproto/pair-client": minor
"@agentproto/runtime": minor
"@agentproto/apps": patch
"@agentproto/cli": patch
---

Remove every link to the retired cli.agentproto.sh host. `PAIR_WEB_URL` (the opt-in shared pair page on that host) is no longer exported; the default per-daemon pair page is unchanged, and a self-hosted shared page still works through `pairing.pairPage` / `--pair-page`. The daemon no longer trusts the `https://cli.agentproto.sh` origin by default. `remote_enable` only returns a `phoneUrl` when the `@agentik/session-chat` app is installed (there is no hosted panel fallback anymore; pair a phone through rendezvous with `agentproto pair offer --qr`). The session-story panel's "panneau complet" link now opens the daemon's own live-session panel for that session, and is hidden when the panel is not served by the daemon.
