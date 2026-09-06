# @agentproto/provider-kit

## 0.4.2

### Patch Changes

- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

## 0.4.1

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.

## 0.4.0

### Minor Changes

- f3b54ad: Implement harness capability discovery — a new layer that answers "what can this adapter actually DO on this host right now" by discovering credentials, providers, model-discovery mechanisms, endpoint compatibility, and application contracts at runtime. Each adapter optionally exports a `<camelSlug>Capabilities` strategy that parses its native config/creds stores (e.g., `~/.gemini/settings.json`, `~/.hermes/auth.json`) to report live state. Falls back gracefully to a pure manifest projection when no strategy is available or it throws. Never surfaces raw credential values — only presence, fingerprints, and last-4 chars. Exposed via the new `harness_capabilities` MCP tool and `@agentproto/cli`'s `listHarnessCapabilities` function.

## 0.3.0

### Minor Changes

- 2f8ba2d: Stop misdirecting zero-credential agent-cli users to buy a subscription

## 0.2.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0

## 0.2.0

### Minor Changes

- b77a552: Rename adapter-kit → provider-kit; add adapter-kit@0.2.0 compatibility shim

### Patch Changes

- 6a0d8fe: Fix stale adapter-kit references in docs, README, and CHANGELOG header

## 0.1.0

### Minor Changes

- 250f474: Migrate tunnel providers onto a slug-keyed adapter-kit registry; ngrok now creatable end-to-end; third-party providers pluggable
- 0d3b8f9: Add @agentproto/adapter-kit and migrate tunnel/browser/CLI adapter families onto it
- 7fec1bc: Add multi-field makeSetupTool variant; migrate cloudflare-named to SetupField[]
- 4b2c9ec: Add opt-in checkDuringListing flag and AdapterEntry.checkFailed field
