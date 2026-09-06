# @agentproto/adapter-gemini

## 0.2.8

### Patch Changes

- @agentproto/driver-agent-cli@2.4.1
- @agentproto/provider-kit@0.4.2

## 0.2.7

### Patch Changes

- Updated dependencies [dfda0b1]
- Updated dependencies [f0c51a7]
- Updated dependencies [12bb9e8]
  - @agentproto/driver-agent-cli@2.4.0
  - @agentproto/provider-kit@0.4.2

## 0.2.6

### Patch Changes

- Updated dependencies [76f2c78]
- Updated dependencies [64088e0]
- Updated dependencies [e3ad769]
  - @agentproto/driver-agent-cli@2.3.1

## 0.2.5

### Patch Changes

- Updated dependencies [27a22ca]
- Updated dependencies [ce7cbb7]
- Updated dependencies [cbe11c2]
  - @agentproto/driver-agent-cli@2.3.0

## 0.2.4

### Patch Changes

- Updated dependencies [bf3407e]
- Updated dependencies [82ca9e6]
  - @agentproto/driver-agent-cli@2.2.2

## 0.2.3

### Patch Changes

- Updated dependencies [08bcd4a]
  - @agentproto/driver-agent-cli@2.2.1

## 0.2.2

### Patch Changes

- Updated dependencies [3e187e5]
- Updated dependencies [492240c]
  - @agentproto/driver-agent-cli@2.2.0

## 0.2.1

### Patch Changes

- Updated dependencies [c1399f3]
  - @agentproto/provider-kit@0.4.1

## 0.2.0

### Minor Changes

- 2ef3bd1: Add native `@agentproto/adapter-gemini` AIP-45 adapter for Google's Gemini CLI in ACP mode, with file-based subscription auth ("use my existing Gemini login" via ~/.gemini/oauth_creds.json). Includes comprehensive spawn and auth resolution tests, VSCode profile flow integration, and catalog entry.
- f3b54ad: Implement harness capability discovery — a new layer that answers "what can this adapter actually DO on this host right now" by discovering credentials, providers, model-discovery mechanisms, endpoint compatibility, and application contracts at runtime. Each adapter optionally exports a `<camelSlug>Capabilities` strategy that parses its native config/creds stores (e.g., `~/.gemini/settings.json`, `~/.hermes/auth.json`) to report live state. Falls back gracefully to a pure manifest projection when no strategy is available or it throws. Never surfaces raw credential values — only presence, fingerprints, and last-4 chars. Exposed via the new `harness_capabilities` MCP tool and `@agentproto/cli`'s `listHarnessCapabilities` function.

### Patch Changes

- Updated dependencies [c736c02]
- Updated dependencies [8367648]
- Updated dependencies [93e6309]
- Updated dependencies [c506d87]
- Updated dependencies [392021a]
- Updated dependencies [3865de6]
- Updated dependencies [5643cb6]
- Updated dependencies [f3b54ad]
- Updated dependencies [42f1217]
- Updated dependencies [4542ca3]
- Updated dependencies [c064bc7]
- Updated dependencies [4832ced]
  - @agentproto/driver-agent-cli@2.1.0
  - @agentproto/provider-kit@0.4.0
