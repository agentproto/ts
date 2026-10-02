---
"@agentproto/cli": patch
---

`agentproto doctor` (and the daemon's `build.source`) no longer report an `npm i -g` install as a "workspace build". The CLI entry is now resolved through `realpathSync` (falling back to the raw path on error) before it is classified, so the global bin symlink (`/usr/local/bin/agentproto`) is classified by its real target under `node_modules/@agentproto/cli`.
