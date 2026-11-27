---
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

`agentproto app serve` no longer lets anyone call an app's tools when it listens beyond loopback. With `--host` set to a non-loopback address, the page still loads without a credential, but tool calls and uploads need an access token: `Authorization: Bearer <token>`, or the cookie a first visit to `/?t=<token>` sets. The token comes from `--access-token-file`, `AGENTPROTO_APP_SERVE_TOKEN`, or a generated file in `~/.agentproto/app-serve/` (mode 0600, outside the app folder); `--insecure-no-auth` opts out.

`app serve` also stops serving dotfiles and dot-directories from the UI root (`.well-known` stays).

An app served from a sandbox box (`agent_start` with `appServe`) is protected the same way. The result carries `appServe.entryUrl`, the public URL with the token, and the spawn fails and stops the server if the box's `agentproto` is too old to enforce it. Before this change, the public URL of a served app let anyone run the app's allowed tools inside the box without any token.
