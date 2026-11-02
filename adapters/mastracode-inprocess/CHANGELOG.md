# @agentproto/adapter-mastracode-inprocess

## 0.5.6

### Patch Changes

- Updated dependencies [1b66f60]
- Updated dependencies [1b66f60]
  - @agentproto/model-catalog@0.14.2

## 0.5.5

### Patch Changes

- c53688d: Remove the `defineAgentCli` export from `@agentproto/harness` (it aliased `defineHarness`; use `defineHarness`) and the `defineAgencyV2` export from `@agentproto/agency` (it aliased `defineAgency`; use `defineAgency`). The nine deprecated re-export shim packages are deleted from the repo; use their replacements (`provider-kit`, `agency`, `app`, `doctype`, `harness`, `inference-endpoint`, `bridge`, `pairing`, `processor`). The in-repo adapters and the CLI now call `defineHarness`; no behaviour change.
- Updated dependencies [68c476e]
- Updated dependencies [da71f8c]
- Updated dependencies [0e0fd10]
- Updated dependencies [18584b5]
- Updated dependencies [c350f3a]
- Updated dependencies [c53688d]
- Updated dependencies [3f90a9d]
- Updated dependencies [f1dab61]
- Updated dependencies [dd134f4]
- Updated dependencies [18584b5]
- Updated dependencies [c350f3a]
- Updated dependencies [30961a9]
- Updated dependencies [dd134f4]
- Updated dependencies [30961a9]
  - @agentproto/harness@3.0.0
  - @agentproto/model-catalog@0.14.1
  - @agentproto/provider-kit@0.6.0

## 0.5.4

### Patch Changes

- 7a90c4b: AIP-45 step 2 of 2: the runner formerly published as `@agentproto/driver-agent-cli` now ships as `@agentproto/harness` (on npm since 2.15.0). It gains `defineHarness`, an alias of `defineAgentCli` registered as the AIP-70 `harness/v1` entry, and `SPEC_NAME` is `harness/v1`.

  Users of the old session presets move to `@agentproto/session-presets`; users of `@agentproto/driver-agent-cli` move to `@agentproto/harness` (same API, `defineHarness` added). `@agentproto/driver-agent-cli` stays published as a deprecated shim that re-exports the harness package unchanged, so existing installs keep working.

  The switched dependents only rename their dependency and import specifiers, hence the patch bumps.

- 8d8c10c: Release and doc hygiene after the AIP-70 renames: fix remaining old package
  names and dead paths, add the missing harness and doctype READMEs, document
  the `inference-endpoint` command alongside its `llm-endpoint` alias, and
  classify the AIP-70 rename shims as archived in STATUS.md.
- Updated dependencies [7a90c4b]
- Updated dependencies [d3ce829]
- Updated dependencies [8d8c10c]
- Updated dependencies [8d53429]
- Updated dependencies [84ac51b]
- Updated dependencies [76003b9]
- Updated dependencies [8d53429]
- Updated dependencies [d3ce829]
  - @agentproto/harness@2.16.0
  - @agentproto/model-catalog@0.14.0
  - @agentproto/provider-kit@0.5.0

## 0.5.3

### Patch Changes

- Updated dependencies [9bf6d95]
- Updated dependencies [e613028]
- Updated dependencies [e613028]
- Updated dependencies [9bf6d95]
- Updated dependencies [c14b061]
  - @agentproto/model-catalog@0.13.2
  - @agentproto/driver-agent-cli@2.15.0

## 0.5.2

### Patch Changes

- Updated dependencies [b2593c3]
  - @agentproto/driver-agent-cli@2.14.0

## 0.5.1

### Patch Changes

- Updated dependencies [bec9df2]
  - @agentproto/model-catalog@0.13.1
  - @agentproto/driver-agent-cli@2.13.3

## 0.5.0

### Minor Changes

- a6f7c8b: chore(adapters): default Anthropic model is claude-sonnet-5-5
- a6f7c8b: Introduce `DEFAULT_ANTHROPIC_MODEL` (`claude-sonnet-5-5`) in `@agentproto/model-catalog` as the single source of truth for the platform-wide Anthropic default, and repoint the jcode, mastracode, mastracode-inprocess, opencode, and pi adapter manifests' `models.default` (and, where present, the default menu entry) at it. `adapter-mastracode-inprocess` additionally declares its new `@agentproto/model-catalog` workspace dependency.

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [a6f7c8b]
- Updated dependencies [7ed9762]
- Updated dependencies [a6f7c8b]
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/model-catalog@0.13.0
  - @agentproto/driver-agent-cli@2.13.2
  - @agentproto/provider-kit@0.4.7

## 0.4.6

### Patch Changes

- Updated dependencies [a21b38b]
- Updated dependencies [6796022]
- Updated dependencies [c6ac536]
  - @agentproto/driver-agent-cli@2.13.1

## 0.4.5

### Patch Changes

- Updated dependencies [24f1cf5]
- Updated dependencies [5d2f4b3]
- Updated dependencies [e1a291b]
- Updated dependencies [c1e3dfd]
  - @agentproto/driver-agent-cli@2.13.0

## 0.4.4

### Patch Changes

- Updated dependencies [245ece0]
  - @agentproto/driver-agent-cli@2.12.0

## 0.4.3

### Patch Changes

- Updated dependencies [7eea847]
  - @agentproto/driver-agent-cli@2.11.0

## 0.4.2

### Patch Changes

- Updated dependencies [00fed67]
- Updated dependencies [c982376]
- Updated dependencies [00fed67]
  - @agentproto/driver-agent-cli@2.10.0

## 0.4.1

### Patch Changes

- Updated dependencies [4c9745d]
- Updated dependencies [91630ea]
  - @agentproto/driver-agent-cli@2.9.0

## 0.4.0

### Minor Changes

- 5787677: Declare own-login auth for copilot-cli, antigravity, mastracode-inprocess

### Patch Changes

- Updated dependencies [f4ac811]
- Updated dependencies [58d5a41]
  - @agentproto/driver-agent-cli@2.8.0

## 0.3.22

### Patch Changes

- @agentproto/driver-agent-cli@2.7.1

## 0.3.21

### Patch Changes

- Updated dependencies [a878968]
  - @agentproto/driver-agent-cli@2.7.0

## 0.3.20

### Patch Changes

- Updated dependencies [85051ab]
  - @agentproto/driver-agent-cli@2.6.4

## 0.3.19

### Patch Changes

- @agentproto/driver-agent-cli@2.6.3

## 0.3.18

### Patch Changes

- Updated dependencies [6bace2a]
  - @agentproto/driver-agent-cli@2.6.2

## 0.3.17

### Patch Changes

- Updated dependencies [3d9626a]
  - @agentproto/driver-agent-cli@2.6.1

## 0.3.16

### Patch Changes

- Updated dependencies [88f2836]
- Updated dependencies [6a1bedc]
  - @agentproto/provider-kit@0.4.6
  - @agentproto/driver-agent-cli@2.6.0

## 0.3.15

### Patch Changes

- Updated dependencies [9a5730d]
  - @agentproto/driver-agent-cli@2.5.1

## 0.3.14

### Patch Changes

- Updated dependencies [8c74864]
- Updated dependencies [dc87d79]
- Updated dependencies [583ee19]
- Updated dependencies [c9e8318]
  - @agentproto/driver-agent-cli@2.5.0

## 0.3.13

### Patch Changes

- Updated dependencies [f30c959]
  - @agentproto/provider-kit@0.4.5

## 0.3.12

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [c27f0b8]
  - @agentproto/driver-agent-cli@2.4.4
  - @agentproto/provider-kit@0.4.4

## 0.3.11

### Patch Changes

- @agentproto/driver-agent-cli@2.4.3

## 0.3.10

### Patch Changes

- 81752fa: Update upstream dependencies for improved compatibility and stability: @anthropic-ai/claude-agent-sdk (0.3.263), @mastra/core (1.64.0), @mastra/memory (1.28.2), @types/react-dom (19.2.7), and @tauri-apps/plugin-opener (2.5.5).
- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/driver-agent-cli@2.4.2
  - @agentproto/provider-kit@0.4.3

## 0.3.9

### Patch Changes

- @agentproto/driver-agent-cli@2.4.1
- @agentproto/provider-kit@0.4.2

## 0.3.8

### Patch Changes

- Updated dependencies [dfda0b1]
- Updated dependencies [f0c51a7]
- Updated dependencies [12bb9e8]
  - @agentproto/driver-agent-cli@2.4.0
  - @agentproto/provider-kit@0.4.2

## 0.3.7

### Patch Changes

- e2314b3: Weekly dependency update: minor/patch-range bumps across the workspace.
  - @mastra/core 1.57.0 → 1.59.0
  - @mastra/memory 1.26.0 → 1.26.2
  - @mastra/libsql 1.19.0 → 1.20.0
  - turbo 2.10.9 → 2.10.10
  - unpdf 1.8.0 → 1.8.1
  - e2b 2.38.2 → 2.39.0
  - @anthropic-ai/claude-agent-sdk 0.3.226/0.3.232 → 0.3.233
  - @earendil-works/pi-tui 0.84.1 → 0.84.2
  - mastracode 0.32.6 → 0.33.1

- b95e23b: Weekly dependency update: bump external dependencies to latest minor/patch versions.
  - @anthropic-ai/claude-agent-sdk 0.3.233 → 0.3.241
  - @ast-grep/napi 0.45.1 → 0.45.2
  - @mastra/core 1.59.0 → 1.61.0
  - @mastra/libsql 1.20.0 → 1.21.1
  - @mastra/memory 1.26.2 → 1.27.0
  - @tanstack/react-query 5.66.0 → 5.102.2
  - @types/react-dom 19.2.4 → 19.2.5
  - @types/vscode 1.90.0 → 1.134.0
  - e2b 2.39.0 → 2.45.0
  - mastracode 0.33.1 → 0.35.0
  - turbo 2.10.10 → 2.10.11

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

- Updated dependencies [76f2c78]
- Updated dependencies [64088e0]
- Updated dependencies [e3ad769]
  - @agentproto/driver-agent-cli@2.3.1

## 0.3.6

### Patch Changes

- a30db02: Stamp source/discoverable fields on capability strategy results
- Updated dependencies [27a22ca]
- Updated dependencies [ce7cbb7]
- Updated dependencies [cbe11c2]
  - @agentproto/driver-agent-cli@2.3.0

## 0.3.5

### Patch Changes

- Updated dependencies [bf3407e]
- Updated dependencies [82ca9e6]
  - @agentproto/driver-agent-cli@2.2.2

## 0.3.4

### Patch Changes

- e68c999: Weekly minor/patch dependency bump (w33). Fixes `TUI` class → `TuiMainScreen` rename from `@earendil-works/pi-tui` 0.84.1.

## 0.3.3

### Patch Changes

- Updated dependencies [08bcd4a]
  - @agentproto/driver-agent-cli@2.2.1

## 0.3.2

### Patch Changes

- Updated dependencies [3e187e5]
- Updated dependencies [492240c]
  - @agentproto/driver-agent-cli@2.2.0

## 0.3.1

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
- Updated dependencies [c1399f3]
  - @agentproto/provider-kit@0.4.1

## 0.3.0

### Minor Changes

- 831d4f5: Implement route-selection axis for AIP-45 launch-menu drill-down (WP1): add declarative `routeSelection` field to adapter manifests (distinguishes "free" vs. "derived-from-model"), project it through resolve/runtime layers, enrich catalog with per-route `multiModel` flags and flat routes index for tier-pinning logic.
- f3b54ad: Implement harness capability discovery — a new layer that answers "what can this adapter actually DO on this host right now" by discovering credentials, providers, model-discovery mechanisms, endpoint compatibility, and application contracts at runtime. Each adapter optionally exports a `<camelSlug>Capabilities` strategy that parses its native config/creds stores (e.g., `~/.gemini/settings.json`, `~/.hermes/auth.json`) to report live state. Falls back gracefully to a pure manifest projection when no strategy is available or it throws. Never surfaces raw credential values — only presence, fingerprints, and last-4 chars. Exposed via the new `harness_capabilities` MCP tool and `@agentproto/cli`'s `listHarnessCapabilities` function.

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
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

## 0.2.6

### Patch Changes

- Updated dependencies [cc00682]
  - @agentproto/driver-agent-cli@2.0.1

## 0.2.5

### Patch Changes

- Updated dependencies [1411e36]
- Updated dependencies [b16bb83]
- Updated dependencies [a021138]
- Updated dependencies [9fab1ad]
- Updated dependencies [92c1c51]
- Updated dependencies [48c55d5]
  - @agentproto/driver-agent-cli@2.0.0

## 0.2.4

### Patch Changes

- Updated dependencies [dd3386d]
- Updated dependencies [2f8ba2d]
- Updated dependencies [68d3093]
  - @agentproto/driver-agent-cli@1.2.0

## 0.2.3

### Patch Changes

- Updated dependencies [9cec8c5]
- Updated dependencies [8d73291]
  - @agentproto/driver-agent-cli@1.1.0

## 0.2.2

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
- Updated dependencies [049c2fe]
- Updated dependencies [0ea6fc1]
- Updated dependencies [386a573]
- Updated dependencies [c036f59]
- Updated dependencies [76747fc]
- Updated dependencies [d425044]
- Updated dependencies [2d94149]
  - @agentproto/driver-agent-cli@1.0.0

## 0.2.1

### Patch Changes

- 4c88fe1: Stop advertising Anthropic models in adapter model menus
- Updated dependencies [6b8b023]
- Updated dependencies [7142f1c]
- Updated dependencies [6f867e1]
- Updated dependencies [6c83622]
- Updated dependencies [3a76562]
- Updated dependencies [b65ca15]
- Updated dependencies [a28bebc]
- Updated dependencies [7f8b45a]
  - @agentproto/driver-agent-cli@0.4.0

## 0.2.0

### Minor Changes

- 06132bc: Implement the AIP-45 `protocol: "proprietary"` arm end to end: `createProprietaryProtocolArm` now dynamic-loads an adapter's `createAgentCliClient` factory and `createAgentCliRuntime` skips the subprocess spawn for it. Ship `@agentproto/adapter-mastracode-inprocess`, a new adapter driving Mastra Code in-process via its SDK (`createMastraCode` + `runMC`) instead of spawning the CLI, with a composite `resourceId:threadId` session id that verifiably survives a process restart. Register the new `mastracode-inprocess` slug in the CLI's adapter catalog.

  Fix `resolveAdapter` to rewrite a `protocol: "proprietary"` handle's `adapter` field to a fully-resolved absolute path before handing it off — `createProprietaryProtocolArm` re-imports that field a second time from `@agentproto/driver-agent-cli`'s own module location (which deliberately depends on no specific adapter), so a bare package-name specifier that resolved fine during discovery could fail to resolve at session-start. Applies to every proprietary adapter, not just this one.

- 06132bc: Implement AIP-45 proprietary protocol arm; ship adapter-mastracode-inprocess

### Patch Changes

- c2b6779: Fix mcpServers/orchestrator mounting silently no-op'ing on mastracode and mastracode-inprocess adapters
- Updated dependencies [06132bc]
- Updated dependencies [2d1434a]
- Updated dependencies [1bf295b]
- Updated dependencies [83aa850]
- Updated dependencies [872226b]
- Updated dependencies [78d09e6]
- Updated dependencies [559cff3]
- Updated dependencies [06132bc]
- Updated dependencies [c2b6779]
- Updated dependencies [e27fc94]
- Updated dependencies [837967a]
  - @agentproto/driver-agent-cli@0.3.0
