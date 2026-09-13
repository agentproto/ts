---
name: install-agentproto-app
description: Register this directory's agentproto app bundle with the local agentproto CLI so the daemon can find and run it. Trigger phrases include "install this book", "install this bundle", "set up this app", "register this app with agentproto".
---

# Install this agentproto app

## What this does

Registers this directory's `.agentproto/APP.md`-defined app with the local
`agentproto` CLI, so the daemon (`agentproto serve`) can resolve it by id.
This skill is intentionally generic — it does not read or care about
whatever this particular bundle declares (book, kit, dashboard…); it only
shells out to the one CLI verb every agentproto app installs through.

## Steps

1. Confirm `agentproto` is installed and on `PATH`:

   ```bash
   agentproto --version
   ```

   If it isn't, install it first — `npm i -g @agentproto/cli`, or whatever
   this bundle's own README recommends.

2. From this directory (the one containing `.agentproto/APP.md`), run:

   ```bash
   agentproto app install .
   ```

   This reads the app's `id` from `.agentproto/APP.md` and registers
   `id -> this directory` in `~/.agentproto/apps.json` — the same mapping
   the daemon's `app_install` tool writes. Re-running it for the same id
   is safe (idempotent): it updates the existing entry rather than erroring.

3. Make sure the daemon is running (skip if it's already up, e.g. as a
   background service):

   ```bash
   agentproto serve
   ```

4. The app is now installed. What "using" it looks like from here depends
   on the client — the daemon's `app_*` MCP tools (`app_run`, `app_apply`,
   `app_status`, …), or `agentproto app serve .` for a standalone browser
   view, are both fair game. This skill's job stops at "installed and
   registered."

## Gotchas

- `agentproto app install` needs a `.agentproto/APP.md` in the target
  directory (an app dir, not an arbitrary folder) — run it from the app's
  root, or pass that root as the argument instead of `.`.
- Installing an app is not the same as running it — this skill covers
  registration only.
