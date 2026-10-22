# @agentproto/adapter-gemini

## 0.2.32

### Patch Changes

- Updated dependencies [c14b061]
  - @agentproto/driver-agent-cli@2.15.0

## 0.2.31

### Patch Changes

- Updated dependencies [b2593c3]
  - @agentproto/driver-agent-cli@2.14.0

## 0.2.30

### Patch Changes

- @agentproto/driver-agent-cli@2.13.3

## 0.2.29

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/driver-agent-cli@2.13.2
  - @agentproto/provider-kit@0.4.7

## 0.2.28

### Patch Changes

- Updated dependencies [a21b38b]
- Updated dependencies [6796022]
- Updated dependencies [c6ac536]
  - @agentproto/driver-agent-cli@2.13.1

## 0.2.27

### Patch Changes

- 5d2f4b3: Harness freshness + safe upgrades: `agentproto harness outdated|check|upgrade`. Adapters can now declare an AIP-45 `upgrade` block (latest-version source, in-place upgrade argv, optional exact-version rollback); the six globally-installed harnesses (opencode, hermes, gemini, pi, mastracode, copilot-cli) declare one. `upgrade` re-runs an ACP smoke probe (initialize + session/new, no prompt) after every upgrade and rolls back to the recorded previous version when it fails, guarded by the `version_check.range` check and a live-daemon-session check (both bypassable with `--force`).
- Updated dependencies [24f1cf5]
- Updated dependencies [5d2f4b3]
- Updated dependencies [e1a291b]
- Updated dependencies [c1e3dfd]
  - @agentproto/driver-agent-cli@2.13.0

## 0.2.26

### Patch Changes

- Updated dependencies [245ece0]
  - @agentproto/driver-agent-cli@2.12.0

## 0.2.25

### Patch Changes

- Updated dependencies [7eea847]
  - @agentproto/driver-agent-cli@2.11.0

## 0.2.24

### Patch Changes

- Updated dependencies [00fed67]
- Updated dependencies [c982376]
- Updated dependencies [00fed67]
  - @agentproto/driver-agent-cli@2.10.0

## 0.2.23

### Patch Changes

- Updated dependencies [4c9745d]
- Updated dependencies [91630ea]
  - @agentproto/driver-agent-cli@2.9.0

## 0.2.22

### Patch Changes

- Updated dependencies [f4ac811]
- Updated dependencies [58d5a41]
  - @agentproto/driver-agent-cli@2.8.0

## 0.2.21

### Patch Changes

- @agentproto/driver-agent-cli@2.7.1

## 0.2.20

### Patch Changes

- Updated dependencies [a878968]
  - @agentproto/driver-agent-cli@2.7.0

## 0.2.19

### Patch Changes

- Updated dependencies [85051ab]
  - @agentproto/driver-agent-cli@2.6.4

## 0.2.18

### Patch Changes

- @agentproto/driver-agent-cli@2.6.3

## 0.2.17

### Patch Changes

- Updated dependencies [6bace2a]
  - @agentproto/driver-agent-cli@2.6.2

## 0.2.16

### Patch Changes

- Updated dependencies [3d9626a]
  - @agentproto/driver-agent-cli@2.6.1

## 0.2.15

### Patch Changes

- Updated dependencies [88f2836]
- Updated dependencies [6a1bedc]
  - @agentproto/provider-kit@0.4.6
  - @agentproto/driver-agent-cli@2.6.0

## 0.2.14

### Patch Changes

- Updated dependencies [9a5730d]
  - @agentproto/driver-agent-cli@2.5.1

## 0.2.13

### Patch Changes

- Updated dependencies [8c74864]
- Updated dependencies [dc87d79]
- Updated dependencies [583ee19]
- Updated dependencies [c9e8318]
  - @agentproto/driver-agent-cli@2.5.0

## 0.2.12

### Patch Changes

- Updated dependencies [f30c959]
  - @agentproto/provider-kit@0.4.5

## 0.2.11

### Patch Changes

- Updated dependencies [c27f0b8]
  - @agentproto/driver-agent-cli@2.4.4
  - @agentproto/provider-kit@0.4.4

## 0.2.10

### Patch Changes

- @agentproto/driver-agent-cli@2.4.3

## 0.2.9

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/driver-agent-cli@2.4.2
  - @agentproto/provider-kit@0.4.3

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
