# @agentproto/plugin-local-browser

## 0.3.0

### Minor Changes

- 8c74864: stdio MCP-server entries now carry `args` and `env` end to end: the ACP schema, runtime tool/HTTP parsing, spawn and restart mount builders, the file-based config converter, and the VS Code client type all forward them instead of silently dropping them. The local-browser plugin additionally exports headless per-session browser helpers (`ensureChromeDevtoolsMcp`, `resolveChrome`, `buildHeadlessBrowserMcpEntry`, …) and `installChromeMcp` gains generic `pkg`/`binName` options.
- e7a2958: Per-session headless browser: `agent_start`/HTTP/CLI spawns accept `browser: "headless"` (off by default), mounting an isolated chrome-devtools-mcp stdio server with a per-session Chrome profile that is swept on session exit; `buildHeadlessBrowserMcpEntry` gains an optional `userDataDir`.

## 0.2.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.2.0

### Minor Changes

- 5284213: Relocate local-browser skill into skill-pack-bureau. Consolidates skill distribution into the dedicated skill pack; plugin functionality and TypeScript API remain unchanged. Users should install the skill via `agentproto install skill/local-browser --pack bureau-plugin` instead of from the plugin package.

## 0.1.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
