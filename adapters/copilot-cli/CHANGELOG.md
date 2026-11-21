# @agentproto/adapter-copilot-cli

## 0.5.0

### Minor Changes

- 2727165: Bring the `copilot-cli` harness up to date with Copilot CLI 1.0.113. The ACP client now resolves the reasoning-effort config id from the session's advertised `configOptions` (`effort`, then `reasoning_effort`, then the `thought_level` category) instead of hard-coding `effort`, which Copilot rejects — so the requested effort is no longer silently dropped on Copilot, both at session start and for a mid-session `agent_set_effort` (Claude, Codex and OpenCode keep `effort`). The Copilot harness now declares its real model menu (`mai-code-2`, `claude-sonnet-5.5`, …) instead of an empty `modelCount`, declares `multimodal: true` (image prompt proved live), and documents the agent / plan / autopilot modes, the `reasoning_effort` id and that two concurrent prompts cancel each other (`steering: false` is correct). Docs and metadata are marked verified on 1.0.113.

### Patch Changes

- d1b33fa: A session can now change its own model or harness and run its own harness commands.

  - New MCP tool `session_handoff` (callable on the caller itself): hands the work to another model and/or harness. The successor takes the label, parent, children, follows and the declared succession (`succeeds`); the source is closed only after the successor is confirmed running. `context` picks what travels: `handoff-summary` (default; status plus the previous session id and a `transcript_read` pointer), `harness-compact` (native `/compact`, then the model switch) or `none` (model switch in place, no new session). Model policy and auth-profile allow-lists are enforced with an explicit `model_refused`.
  - New MCP tool `session_command_self`: queues a harness slash-command (`/compact`, `/clear`, `/model x`, ...) on the caller's own prompt queue, run when its current turn ends. Gated by an allow-list in the adapter manifest (`capabilities.selfCommands`, config `acpAgents.*.self_commands`; only the confirmed `compact`/`compress`/`model` are declared) and by the commands the harness advertises; `compactRequiresOperator` still applies.

- 069a055: Slim `session_handoff`: no `full-resume` mode, the new-session case reuses `session_continue_fresh`'s path, and every continuation prompt now points at `transcript_read` for the previous session. `harness-compact` is source-less for an operator call (honours `compactRequiresOperator`) and refuses when the harness doesn't advertise the compact command; a self-handoff reports `sourceClosePending`. Adapter manifests declare only the confirmed `selfCommands` (`compact`; hermes `compress`, `model`).
- Updated dependencies [d1b33fa]
  - @agentproto/harness@4.1.0

## 0.4.4

### Patch Changes

- Updated dependencies [c6d6c8f]
- Updated dependencies [f001d73]
  - @agentproto/harness@4.0.0

## 0.4.3

### Patch Changes

- Updated dependencies [ae6751d]
  - @agentproto/harness@3.1.0

## 0.4.2

### Patch Changes

- @agentproto/harness@3.0.1

## 0.4.1

### Patch Changes

- c53688d: Remove the `defineAgentCli` export from `@agentproto/harness` (it aliased `defineHarness`; use `defineHarness`) and the `defineAgencyV2` export from `@agentproto/agency` (it aliased `defineAgency`; use `defineAgency`). The nine deprecated re-export shim packages are deleted from the repo; use their replacements (`provider-kit`, `agency`, `app`, `doctype`, `harness`, `inference-endpoint`, `bridge`, `pairing`, `processor`). The in-repo adapters and the CLI now call `defineHarness`; no behaviour change.
- Updated dependencies [68c476e]
- Updated dependencies [da71f8c]
- Updated dependencies [0e0fd10]
- Updated dependencies [c350f3a]
- Updated dependencies [c53688d]
- Updated dependencies [f1dab61]
- Updated dependencies [dd134f4]
- Updated dependencies [c350f3a]
- Updated dependencies [30961a9]
- Updated dependencies [dd134f4]
- Updated dependencies [30961a9]
  - @agentproto/harness@3.0.0

## 0.4.0

### Minor Changes

- c9247fe: Declare the native hook capabilities of the Gemini CLI and GitHub Copilot CLI harnesses under `capabilities.hooks`.
- c9247fe: Declare the native hook capabilities of the Gemini CLI and GitHub Copilot CLI harnesses under `capabilities.hooks`, mirroring the action-hooks capability matrix.

### Patch Changes

- 7a90c4b: AIP-45 step 2 of 2: the runner formerly published as `@agentproto/driver-agent-cli` now ships as `@agentproto/harness` (on npm since 2.15.0). It gains `defineHarness`, an alias of `defineAgentCli` registered as the AIP-70 `harness/v1` entry, and `SPEC_NAME` is `harness/v1`.

  Users of the old session presets move to `@agentproto/session-presets`; users of `@agentproto/driver-agent-cli` move to `@agentproto/harness` (same API, `defineHarness` added). `@agentproto/driver-agent-cli` stays published as a deprecated shim that re-exports the harness package unchanged, so existing installs keep working.

  The switched dependents only rename their dependency and import specifiers, hence the patch bumps.

- Updated dependencies [7a90c4b]
- Updated dependencies [8d8c10c]
- Updated dependencies [84ac51b]
  - @agentproto/harness@2.16.0

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
