# @agentproto/apps

## 0.7.0

### Minor Changes

- 85c391c: Add `session-viewer` app — a read-only conversation viewer for daemon sessions with a live-polling UI panel and plain-English narrator agent.

### Patch Changes

- Updated dependencies [e418ec7]
  - @agentproto/app-kit@0.6.1

## 0.6.0

### Minor Changes

- 172368f: Add support for multiple MCP server aliases in mail-triage app: `MAIL_TRIAGE_MCP_ALIASES` (overridable via env var, defaults to `["agentpush-prod", "agentpush"]`) enables flexible server selection at emit-time. UI now probes all candidate aliases at startup and auto-selects the first responding server, with a selector dropdown when multiple respond. Enhance plan builder with query input and action selector (mark read, archive, label, trash). Add "Past runs" section using new `app_list` tool to display agent run history with status and session counts. Export `MAIL_TRIAGE_MCP_ALIASES` constant for testing and configuration. Improve agent instructions to explain `mailbox_list` discovery step and new parameter contracts (mailbox ID, criteria, action schema).
- 2375019: Extend the MCP app bridge wire (spec 2026-01-26) with three new methods and integrate them into the mail-triage UI:
  - **`updateModelContext`** (`@agentproto/runtime`): lets an app push updated context back to the model over the bridge; marshaled through JSON-RPC on the postMessage bridge, rejected with a clear error on the standalone bridge.
  - **`openLink`** (`@agentproto/runtime`): lets an app request the host open a URL; the postMessage bridge marshals the request through JSON-RPC, the standalone bridge falls back to `window.open`.
  - **`onTeardown`** (`@agentproto/runtime`): registers a callback invoked when the host sends `ui/resource-teardown`; the bridge replies with `{result:{}}` after running registered callbacks synchronously.
  - **Mail-triage UI** (`@agentproto/apps`): adds email selection via checkboxes, a "send selection" action that pushes selected emails to the model via `updateModelContext`, and "open in Gmail" links wired through `openLink`.

### Patch Changes

- 59bc722: Three fixes around MCP app panels and session restart:
  - **MCP bridge injection** (`@agentproto/runtime`, `@agentproto/apps`): fix the idempotency check that incorrectly skipped injection for documents consuming `window.McpApp.connect()` — regex narrowed from `/window\.McpApp\b/` (any mention) to `/window\.McpApp\s*=/` (assignments only). Defensive guard in mail-triage UI when the bridge is missing.
  - **Credential re-resolution on restart** (`@agentproto/runtime`): pass `accessProfileRef` to `resolveResumeAuth` so restarting a session that used a named auth profile re-reads the current credential from the keychain instead of falling back to a stale mode-based path.
  - **Restart loading state** (`agentproto-vscode`): show a loading state and disable the restart button while a session restart is in flight; new `restartFailed` webview message resets the state on error.

- Updated dependencies [33e97d3]
- Updated dependencies [d22fec5]
- Updated dependencies [3d54f15]
  - @agentproto/app-kit@0.6.0

## 0.5.1

### Patch Changes

- 69e97d9: Documentation sync: version bumps, turn-liveness watchdog config details, UI surfaces/artifacts/dev-launch config examples, and agentproto-apps-sync binary documentation.
- Updated dependencies [69e97d9]
  - @agentproto/app-kit@0.5.1

## 0.5.0

### Minor Changes

- 1d3cbc2: Add stable id/name/version identity to bundled apps; fix app-registry persistence
- 4c91a47: Add UI panels for mail-triage and media-viewer apps with self-contained HTML dashboards using the McpApp bridge protocol. Introduce `agentproto-apps-sync` CLI utility to emit bundled apps to disk with catalog generation.

### Patch Changes

- b7171eb: Documentation update: add media-viewer app to package README
- Updated dependencies [4b73e28]
- Updated dependencies [b098b52]
  - @agentproto/app-kit@0.5.0

## 0.4.0

### Minor Changes

- 727ba11: Add media-viewer agentproto app for media file cataloging with cataloger agent and scan-media workflow.

## 0.3.0

### Minor Changes

- ea4313a: Add `mail-triage` app: a single-agent example that scans the inbox, categorizes unread mail, and applies triage actions (label, archive) via app-kit.

### Patch Changes

- 087f0ea: Declarative agent steps for AIP-15 workflows (WP-B4): author `kind:"agent"` steps with `agent.ref` (app-scoped agent ids) that resolve at compile time to concrete adapters + spawn options. Includes app installation/lifecycle tools (`app_install`, `app_run`, `app_list`, `app_status`, `app_stop`) for managing installed-app state and running agents as live sessions. Tool-id validation now shifts from STEP-DISPATCH time to INSTALL time, listing all missing ids upfront instead of failing one-at-a-time.
- Updated dependencies [47ca357]
- Updated dependencies [087f0ea]
- Updated dependencies [2b379e9]
  - @agentproto/app-kit@0.4.0
  - @agentproto/workflow@0.2.0

## 0.2.2

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
- Updated dependencies [c1399f3]
  - @agentproto/app-kit@0.3.2

## 0.2.1

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- Updated dependencies [23fa73e]
- Updated dependencies [04aedad]
  - @agentproto/workflow@0.1.1
  - @agentproto/app-kit@0.3.1

## 0.2.0

### Minor Changes

- b2debf0: Add illustrator agent and produce-cover workflow to the content-team app: a new team member that art-directs cover illustrations for articles with visual discipline (flat shapes, limited palettes, strong negative space, text-free prompts).

### Patch Changes

- 4252c81: Fix subpath export types pointing at nonexistent flat .d.ts files
- Updated dependencies [a0b94fd]
  - @agentproto/app-kit@0.3.0

## 0.1.1

### Patch Changes

- c850b1b: Infer anthropic for bare claude model ids; grant team agents their workspace tools
- e3bacf3: Add app-kit pick()/only, fix content-team tools, self_inspect discovers app-emitted agents
- Updated dependencies [e3bacf3]
  - @agentproto/app-kit@0.2.0
