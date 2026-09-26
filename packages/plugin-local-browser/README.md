# @agentproto/plugin-local-browser

Bridge a real local Chrome profile (cookies, signed-in sessions,
extensions) into the agentproto daemon as a proxied MCP server. After
setup, every host connected over the daemon's tunnel sees the 29
`chrome-devtools-mcp` browser tools (`navigate_page`, `click`, `fill`,
`take_screenshot`, `evaluate_script`, …) alongside the daemon's
built-in workspace tools.

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
3. Installs `chrome-devtools-mcp` into `~/.agentproto/chrome-mcp/`
   (plugin-owned npm prefix). Resolved-by-absolute-path so the
   daemon's MCP proxy can spawn it without going through any `npx`
   shim — important because the daemon itself is typically launched
   via `npm exec @agentproto/cli@latest`, and nested npm-exec calls
   misinterpret `<pkg>@<version>` specs.
4. Writes an entry into `~/.agentproto/imported-mcps.json` pointing
   at the installed bin with `--userDataDir` set to the clone and
   `--chromeArg=--profile-directory=<name>` set to your chosen
   profile.
5. Restart the daemon (`~/.agentproto/start-daemon-prod.sh`) — its
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

## Claude Code skill (optional)

The `local-browser` skill — teaching agents when to drive the browser,
which of the 29 tools to reach for, and the safety rails to apply — ships
as part of the `@agentproto/skill-pack-bureau` pack, alongside this
plugin's browser-family siblings:

```bash
agentproto install skill/local-browser --pack bureau-plugin
```

## Headless mode (per-session browser for spawned agents)

Separate from the authed-profile bridge above, the package also exports
building blocks for a throwaway headless browser that a daemon-spawned agent
gets through its own `mcpServers`. It uses no user profile and no shared
proxy:

```ts
import {
  ensureChromeDevtoolsMcp,   // install once into ~/.agentproto/chrome-mcp, cached + concurrency-safe
  resolveChrome,             // AGENTPROTO_CHROME_PATH → system Chrome → chrome-headless-shell (downloaded if missing)
  buildHeadlessBrowserMcpEntry,
} from "@agentproto/plugin-local-browser"

const mcp = await ensureChromeDevtoolsMcp()
const chrome = await resolveChrome()
const entry = buildHeadlessBrowserMcpEntry({ mcp, executablePath: chrome.path })
// → { name: "browser", transport: "stdio", ref: <node>, args: [<chrome-devtools-mcp>,
//     "--headless", "--isolated", "--viewport", "1440x900", …], env: {…} }
```

`--isolated` gives each server its own temporary profile. That profile is
deleted when the server exits.

### Validation under `commandSandbox` (macOS Seatbelt, 2026-09-26)

Setup:
- Chrome 154 and chrome-headless-shell 154.0.8037.57.
- chrome-devtools-mcp 1.0.1 and 1.10.1.
- The whole driver + MCP + Chrome tree ran under
  `buildSeatbeltProfile({ workspace, network })`, as it would under an
  adapter spawn.

The check: `navigate_page file://…/page.html`, `evaluate_script` returns
`document.title` and a 1440x900 viewport, `take_screenshot` returns a
1440x900 PNG, then a `navigate_page https://example.com`.

| sandbox | Chrome | Chrome sandbox | file:// + screenshot | https:// |
|---|---|---|---|---|
| off | system | on | ✅ | ✅ |
| off | headless-shell | on | ✅ | ✅ |
| workspace | system / headless-shell | on | ❌ `sandbox initialization failed: Operation not permitted`, navigate times out | — |
| workspace | system / headless-shell | `--no-sandbox` | ✅ | ✅ |
| strict | system | `--no-sandbox` | ❌ "browser is already running": `deny network*` blocks Chrome's ProcessSingleton unix socket | — |
| strict | system + allow only `$TMPDIR/com.google.Chrome.*/SingletonSocket` | `--no-sandbox` | ✅ | ❌ `ERR_NAME_NOT_RESOLVED` |
| strict | headless-shell | `--no-sandbox` | ✅ | ❌ `ERR_NAME_NOT_RESOLVED` |

What this means:
- Under any Seatbelt confinement, pass `chromeSandbox: false`. A nested
  `sandbox_init` is refused, and the outer profile still confines the tree.
- Under `strict`, use chrome-headless-shell
  (`resolveChrome({ sources: ["env", "headless-shell"] })`). It works with
  the strict profile unchanged. System Chrome would need a unix-socket
  exception.
- chrome-devtools-mcp 1.10 turned `pageIdRouting` on by default, so every page
  tool then demands a `pageId`. The entry passes `--no-page-id-routing`
  because the browser belongs to a single session. 1.0.1 ignores the flag.

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
