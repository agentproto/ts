# @agentproto/adapter-copilot-cli

## 0.3.11

### Patch Changes

- Updated dependencies [76003b9]
  - @agentproto/driver-agent-cli@2.16.0

## 0.3.10

### Patch Changes

- Updated dependencies [c14b061]
  - @agentproto/driver-agent-cli@2.15.0

## 0.3.9

### Patch Changes

- Updated dependencies [b2593c3]
  - @agentproto/driver-agent-cli@2.14.0

## 0.3.8

### Patch Changes

- @agentproto/driver-agent-cli@2.13.3

## 0.3.7

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/driver-agent-cli@2.13.2

## 0.3.6

### Patch Changes

- Updated dependencies [a21b38b]
- Updated dependencies [6796022]
- Updated dependencies [c6ac536]
  - @agentproto/driver-agent-cli@2.13.1

## 0.3.5

### Patch Changes

- 5d2f4b3: Harness freshness + safe upgrades: `agentproto harness outdated|check|upgrade`. Adapters can now declare an AIP-45 `upgrade` block (latest-version source, in-place upgrade argv, optional exact-version rollback); the six globally-installed harnesses (opencode, hermes, gemini, pi, mastracode, copilot-cli) declare one. `upgrade` re-runs an ACP smoke probe (initialize + session/new, no prompt) after every upgrade and rolls back to the recorded previous version when it fails, guarded by the `version_check.range` check and a live-daemon-session check (both bypassable with `--force`).
- Updated dependencies [24f1cf5]
- Updated dependencies [5d2f4b3]
- Updated dependencies [e1a291b]
- Updated dependencies [c1e3dfd]
  - @agentproto/driver-agent-cli@2.13.0

## 0.3.4

### Patch Changes

- Updated dependencies [245ece0]
  - @agentproto/driver-agent-cli@2.12.0

## 0.3.3

### Patch Changes

- Updated dependencies [7eea847]
  - @agentproto/driver-agent-cli@2.11.0

## 0.3.2

### Patch Changes

- Updated dependencies [00fed67]
- Updated dependencies [c982376]
- Updated dependencies [00fed67]
  - @agentproto/driver-agent-cli@2.10.0

## 0.3.1

### Patch Changes

- Updated dependencies [4c9745d]
- Updated dependencies [91630ea]
  - @agentproto/driver-agent-cli@2.9.0

## 0.3.0

### Minor Changes

- 5787677: Declare own-login auth for copilot-cli, antigravity, mastracode-inprocess

### Patch Changes

- Updated dependencies [f4ac811]
- Updated dependencies [58d5a41]
  - @agentproto/driver-agent-cli@2.8.0

## 0.2.2

### Patch Changes

- @agentproto/driver-agent-cli@2.7.1

## 0.2.1

### Patch Changes

- Updated dependencies [a878968]
  - @agentproto/driver-agent-cli@2.7.0

## 0.2.0

### Minor Changes

- b6c356e: Add @agentproto/adapter-copilot-cli (GitHub Copilot CLI ACP adapter)

### Patch Changes

- Updated dependencies [85051ab]
  - @agentproto/driver-agent-cli@2.6.4
