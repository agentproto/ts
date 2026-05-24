# @agentproto/plugin-local-browser

Bridge a real local Chrome profile (cookies, signed-in sessions,
extensions) into the agentproto daemon as a proxied MCP server. After
setup, every host connected over the daemon's tunnel — Guilde, a
self-hosted gateway, etc. — sees the 29 `chrome-devtools-mcp` browser
tools (`navigate_page`, `click`, `fill`, `take_screenshot`,
`evaluate_script`, …) alongside the daemon's built-in workspace tools.

**Status:** alpha.

## How it works

1. Reads `~/Library/Application Support/Google/Chrome/Local State`
   and presents your existing Chrome profiles (`Default`, `Profile 1`,
   …) with display name + signed-in email.
2. Clones the profile you pick into `~/.agentproto/chrome-profile/`.
   The clone inherits cookies, login state, and extensions; caches
   and lock files are skipped so the copy is ~5–10× smaller than the
   source. Lives at its own user-data-dir so it can run alongside
   your daily Chrome without lock conflicts.
3. Writes an entry into `~/.agentproto/imported-mcps.json` that
   invokes `chrome-devtools-mcp` with `--userDataDir` pointing at
   the clone and `--chromeArg=--profile-directory=<name>` pointing
   at your chosen profile.
4. Restart the daemon (`~/.agentproto/start-daemon-prod.sh`) — its
   MCP proxy picks up the new import and surfaces the browser tools
   through `/mcp` to every tunnel-connected host.

## Install + setup

```bash
npx -y -p @agentproto/plugin-local-browser agentproto-browser setup
```

The picker is interactive. To script it:

```bash
npx -y -p @agentproto/plugin-local-browser agentproto-browser setup \
  --profile "Profile 1" --yes
```

Re-running setup re-clones and replaces the registered entry — the
imported-mcps row stays at a single, stable id.

## Status / remove

```bash
agentproto-browser status     # show the registered entry + clone dir
agentproto-browser remove     # unregister (leaves the clone on disk)
```

## Security

Chrome's remote debugging protocol has no authentication — anything
that can reach it can read every cookie, send mail as you, post as
you. Mitigations baked into this plugin:

- `chrome-devtools-mcp` is spawned as a stdio child of the daemon.
  There's no listening port on the host; the only way in is through
  the daemon's `/mcp` endpoint, which is gated by the daemon's own
  bearer token + tunnel JWT.
- The clone lives at its own user-data-dir, so a compromised
  automation profile can't reach into your daily Chrome's session
  state once the clone is taken.

You should still treat the cloned profile as a sensitive credential —
it carries every cookie that was live when you ran setup.

## License

MIT.
