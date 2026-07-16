# @agentproto/adapter-browser

## 0.1.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/browser-process@0.1.1

## 0.1.0

### Minor Changes

- e33d99a: start_browser no longer blocks the MCP request during a cold start — heavy services (chromium/bureau) register immediately as `starting` and converge to healthy in the background; opt-in via BrowserProcessSpec.initialWaitMs, default behavior unchanged.
- 6738ef9: Surface adapter manifest (location/install/config) over MCP; add binPath to start_browser
- cfbeb8f: Browser-as-adapter stack: adapter-browser, browser-process primitive, `agentproto browser` CLI

### Patch Changes

- 8a24b4b: Fix chromium adapter pnpm filter to use correct @agstudio/browser-service package name
- Updated dependencies [e33d99a]
- Updated dependencies [cfbeb8f]
  - @agentproto/browser-process@0.1.0
