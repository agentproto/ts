# @agentproto/app-kit

## 2.3.0

### Minor Changes

- d732326: App services run as deterministic managed processes: replace the LLM-prompted owner session with a detached, non-PTY child process spawned and supervised by the daemon (sessions-registry registration, structured `cwd/command/args` service declarations with legacy `entry` compatibility, restart backoff + rolling-window cap, group-kill cleanup gated by PID-identity checks, per-app serialization, own `daemon.resumeServicesOnBoot` knob defaulting on, and full reconcile purging services removed from a manifest).

### Patch Changes

- Updated dependencies [733a92a]
  - @agentproto/workspace@1.0.2
  - @agentproto/mastra@0.2.20

## 2.2.0

### Minor Changes

- d81be85: `setup[]` (AIP-53): apps can declare an ordered, idempotent post-install configuration pipeline. `types.ts` gains a discriminated `AppSetupStep` union on `kind` (`cmd`, `prompt`, `oauth`, `external`, `choice`, `auth-profile`, `pairing`, `check`, plus vendor `x-*` steps) mirroring the vendored `APP.schema.json` field-for-field, and `manifest-fields.ts` validates each step's per-kind shape (`when`/`skip_if`/`persist`/`options`/`check` sub-shapes included). `defineApp` enforces conformance rule 10 purely (no I/O, nothing executed): non-empty when present, unique step ids, `when.step` naming an EARLIER step, exactly one `persist` slot per declaring step, `choice.default` among its options, and no `persist.answer` on a `type: secret` prompt — every violation names the step id. `emit` writes `setup` verbatim into APP.md frontmatter only when set; `loadAppHandle` reads it back and re-validates. A host's setup engine runs the steps; app-kit only carries the declaration.
- d81be85: Add AIP-53 `setup[]` — an ordered, idempotent post-install configuration pipeline carried by an app manifest. `types.ts` exports a discriminated `AppSetupStep` union (`cmd`, `prompt`, `oauth`, `external`, `choice`, `auth-profile`, `pairing`, `check`, plus vendor `x-*`) and the supporting `AppSetupWhen`, `AppSetupSkipIf`, `AppSetupPersist`, `AppSetupOption` and `AppSetupCheck` types; `manifest-fields.ts` validates each step's per-kind shape against the vendored `APP.schema.json`; `defineApp` applies conformance rule 10 purely (non-empty, unique ids, `when.step` names an earlier step, exactly one `persist` slot, `choice.default` among its options, no `persist.answer` on a `type: secret` prompt); `emit`/`loadAppHandle` carry it verbatim.

## 2.1.0

### Minor Changes

- 70d533f: `@agentproto/app-kit` adds newly exported `parseServiceList` (and its `ServiceListResult` type) — a non-throwing wrapper around the `services:` manifest validator shared with `defineApp`/`loadAppHandle`, so callers outside the throw-based `normalizeManifestFields` flow get the same rule set.

  `@agentproto/runtime`'s `parseAppServices` now delegates to app-kit's `parseServiceList` instead of carrying its own duplicate validator, unifying the two previously-divergent `services:` rule sets. Install-time validation tightens accordingly (leading-letter names, no unknown object fields, fail-fast on the first bad entry, and an explicitly-present empty `services: []` is rejected).

- 70d533f: `@agentproto/app-kit` exports a new `parseServiceList` — a non-throwing wrapper around the `services:` manifest validator already used by `defineApp`/`loadAppHandle` — so callers outside the throw-based `normalizeManifestFields` flow get the same single rule set.

  `@agentproto/runtime`'s `parseAppServices` now delegates to `@agentproto/app-kit`'s `parseServiceList` instead of carrying its own duplicate validator, unifying the two previously-divergent `services:` rule sets. This changes install-time validation behavior: service names must now start with a letter (a digit-leading name like `0abc` is rejected, though consecutive/trailing hyphens are now allowed), unknown object fields on a service entry are now rejected, validation now fails fast on the first bad entry instead of accumulating every entry's errors, and an explicitly-present but empty `services: []` is now rejected instead of being treated as a no-op.

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [2760272]
- Updated dependencies [74f982c]
  - @agentproto/agent@0.4.1
  - @agentproto/driver@0.3.3
  - @agentproto/driver-cli@0.2.5
  - @agentproto/driver-http@0.1.13
  - @agentproto/mastra@0.2.19
  - @agentproto/tool@0.5.2
  - @agentproto/workflow@0.7.2
  - @agentproto/workflow-loader@0.2.9
  - @agentproto/workspace@1.0.1

## 2.0.0

### Major Changes

- 6ec4039: **BREAKING**: `workspace/v2` (AIP-34, tree composition) replaces `workspace/v1` outright — there is no parallel v1 schema, no v1↔v2 mixed tree, and no legacy compatibility path. `defineWorkspace`, `WorkspaceDefinition`/`WorkspaceHandle`, `workspaceFrontmatterSchema`, `parseWorkspaceManifest`/`workspaceFromManifest`/`writeWorkspaceManifest` now mean v2: `schema` is `"workspace/v2"`, and `type` (a node kind resolved against a tree's `TYPES.md`) is a new REQUIRED field. A caller constructing `{ schema: "workspace/v1", ... }` or omitting `type` now fails validation — see AIP-34 §Migrating from workspace/v1 for the (small) field-by-field rewrite note.

  One schema backs load, export, and verify: `writeWorkspaceManifest` (.ts → .md) and `parseWorkspaceManifest`/`workspaceFromManifest` (.md → object) both validate through `workspaceFrontmatterSchema`, so they can never drift from each other.

  New optional fields: `wall` (four visibility levels: shared/isolated/sealed/hard — default isolated), `includes`/`exports` (two-sided consent doors), `agents`/`routines` (declared manifests this node hosts), `secrets`/`uses_secrets` (never-inherited secret grants, pairs with a new additive `workspace:` access-entry kind on AIP-19 SECRETS.md), `apps`/`accepted_apps` (versioned app attachments — crossing to another node needs that node's explicit `accepted_apps` consent, same two-sided shape as includes/exports), `work` (AIP-20 WORK.md reference — a project's status/board, not a flat status file), and `policy.limits` budget aggregation (most-restrictive-wins down the tree). Companion formats: `TYPES.md` (node-type registry), `agentproto.lock` (tree-wide app/pack lockfile), `EXPORT.md` (sealed/hard digest) — each with its own schema + parse/write pair.

  Adds the first version of the cross-node verifier, `checkWorkspaceTree` (`@agentproto/workspace/checker`) and the CLI surface `agentproto workspace check <dir>`: validates node `type` against `TYPES.md` (allowed parents, wall floor, required files), two-sided `includes`/`exports` and `apps`/`accepted_apps` consent, `uses_secrets` grants against the provider's `SECRETS.md` (plus a no-literal-secret-values heuristic), `policy.limits` budget aggregation, and path confinement (tree-relative paths, no `..` traversal, no symlink escape — checked via realpath, not just the string) on every file reference the checker resolves.

  `@agentproto/app-kit`'s `defineApp`/`WorkspaceShorthand`/`emitApp` migrate along with it: a `WorkspaceShorthand` now accepts an optional `type` (defaulting to `"app"` — an app-kit workspace is a standalone root, not a node in anyone's `TYPES.md` tree), and `emitApp` writes `schema: "workspace/v2"` to the WORKSPACE.md it generates. A caller reading an emitted WORKSPACE.md and asserting `schema === "workspace/v1"` needs updating.

### Patch Changes

- cc7ba9f: Docs sync for features already shipped: the `agentproto app tunnel` verb (`@agentproto/cli` README) and the AIP-53 `services:` production-hosting block (`@agentproto/app-kit` README). README-only changes; no source behavior changed.
- Updated dependencies [6ec4039]
- Updated dependencies [6ec4039]
  - @agentproto/workspace@1.0.0

## 1.10.0

### Minor Changes

- 0d1cb7b: Add AIP-42 agent manifest authoring: the shared `renderAgentManifest` in app-kit, the `agentproto agent create|list` CLI verb, the daemon `create_agent` MCP tool, and spawn-time `agentId`/`agentPath` manifest defaults (plus `sessions start --agent`).
- 5a1a7e0: Add the AIP-53 `services` production-hosting field: a validated, frozen `services: [{ name, entry, port? }]` array on `AppDefinition`/`AppHandle` that `defineApp`, `emitApp` and `loadAppHandle` carry verbatim. app-kit never executes a service `entry`; the host spawns one keep-alive service-owner session per entry at install time. The `services` load error shares the `invalid services declaration` phrase with the runtime install-time launcher.
- 5a1a7e0: Add the AIP-53 `services` frontmatter field (`services: [{ name, entry, port? }]`) — an app's production hosting surface, distinct from the dev-only `dev.launch`. `defineApp`, `loadAppHandle` and `emitApp` validate it (non-empty array, unique kebab-case `name`, non-empty `entry`, optional 1..65535 `port`, no extra keys) and carry it verbatim / round-trip it. app-kit never executes a service `entry`: the host spawns one keep-alive service-owner session per entry at install time (later work item), and `dev.launch` remains validation-only.

### Patch Changes

- Updated dependencies [3a02a3b]
  - @agentproto/agent@0.4.0
  - @agentproto/mastra@0.2.18

## 1.9.0

### Minor Changes

- 0bc2def: A2 — git workspace lifecycle in the sandbox:

  - `@agentproto/runtime`: `appServe` pulls the app's declared `storage: github` `pull-push` workspace inside the box after `app_install` (new exports `readAppGithubWorkspaceSync`, `pullAppGithubWorkspace`, `boxGitRunner`, `boxSyncTree`), an opt-in close-time push rides `onBeforeTeardown` (`createGithubWorkspacePushAtClose`, `composeTeardownHooks`), token lookup via `resolveGithubWorkspaceToken`, and a failed seed clone in `app-workspace` now removes the just-created empty mount dir and warns on a failed auth scrub. New optional `exec` on `SandboxServeHost`.
  - `@agentproto/app-kit`: new `workspaceFromMarkdownText` parses `WORKSPACE.md` text without touching the filesystem (same manifest parse `loadAppHandle` runs), returning `undefined` for anything unparsable or schema-invalid.
  - `@agentproto/storage-github`: `GithubWorkspaceSyncOpts.gitRunner` now also accepts an `AsyncGitRunner`, so the sync contract can be driven over remote exec seams; `writeAuthConfig` is now async and accepts either runner shape.

- 0bc2def: A2 — git workspace lifecycle in the sandbox:

  - `app_install`'s seed-clone follow-ups in `app-workspace`: a failed seed clone now removes the just-created empty mount dir again (nothing of the user's is ever deleted — `rmdir` only succeeds when the dir is empty), and a failed persisted-auth scrub (`git config --remove-section` after a clone) is warned about instead of silently dropped, so the "no credential at rest" guarantee is self-checking.
  - `appServe` pulls the app's declared `storage: github` `pull-push` workspace INSIDE the box after `app_install` and before the UI server launches: empty/missing mount path is cloned, an existing checkout is fetched and merged `--ff-only` (a diverged local branch fails the pull, never clobbered). Git runs through the box's per-command exec seam (`boxGitRunner` is passed to `createGithubWorkspaceSync`), never the host's `spawnSync` against an in-box path. The GitHub token is resolved through the daemon's secrets broker (`resolveGithubWorkspaceTokenFromBroker`) — never ambient `process.env` — and `persistAuth: false` keeps it off the box's command line and out of `.git/config` (every git call injects it via `SandboxExecOpts.env`). `pull`'s outcome is read from a real discriminant (`PullResult.ok`), not a message substring. An invalid declaration, a missing token, or a failed pull is warned about and never breaks the serve.
  - Opt-in push at session close: a declaration carrying BOTH a non-`main` `sync.push.branch_policy` AND a non-`none` `pr_policy` opts in; the hook runs on the box proxy's `onBeforeTeardown` (the last moment the box filesystem is reachable), pushing the working tree as `agentproto/<session>` / `agentproto/turn-<id>` per the branch policy, never the base branch. It is wired on the spawn path AND on the restart/re-attach paths, so a resumed session pushes like a fresh one. Without the declaration (or with `main`), nothing pushes. Failures are warned, never block the teardown.
  - `@agentproto/app-kit` gains `workspaceFromMarkdownText`: parse WORKSPACE.md text without touching the filesystem — the same manifest parse `loadAppHandle` runs on the file, lifted to a string so a caller holding text read from a box gets the identical validated handle (returns `undefined` for anything unparsable).
  - `@agentproto/storage-github`: `GithubWorkspaceSyncOpts.gitRunner` now also accepts an async runner (per-call `await`; sync runners unchanged), a new `persistAuth` opt (default `true`) can skip persisting the auth header for remote-seam runs, and `pull` now reports `PullResult.ok` on every path. `@agentproto/storage`'s `PullResult` gains that optional `ok` discriminant (a healthy refresh is `seeded: false, ok: true`; a failed clone/fetch/merge is `ok: false`).

## 1.8.0

### Minor Changes

- 38a1c34: feat(app-kit,runtime): AIP-53 `ui.toolScope` link-token scoping, Telegram-identity-bound — closes the argument-scoping gap in `app_tool_call`/`POST /apps/:appId/tool-call` (an allowlisted UI tool like `conversation_read` could be called with ANY `sessionId`, not just the one it was shown for). `defineApp`'s `ui` gains an optional `toolScope` map (`{ toolName: { argName: "$link.<claim>" } }`), validated against `ui.tools` and carried through emit/load/install onto `InstalledApp.ui.toolScope`. A new privileged `app_link_mint` daemon tool (never placeable in `ui.tools`, refused unconditionally by `dispatchAllowlistedAppTool`) mints a short-lived, HMAC-signed link token bound to one `(appId, sessionId, telegramUserId)` — useless on its own until the opener's Telegram Mini App `initData` is verified against the daemon's stored bot token via the new `POST /apps/:appId/link-auth` (`app-link-auth.ts`), which exchanges it for a short-lived session token. `dispatchAllowlistedAppTool` runs in a fail-closed scoped mode under that session token: only tools in `ui.toolScope` are reachable, with their scoped arguments checked against the token's claims (absent → injected, mismatched → refused) — no union with `ui.tools`/`APP_UI_DISCOVERY_TOOLS`. `tunnelBearerAllowed` and the tool-call route's browser/bearer gates (http-server.ts) accept a valid session token ONLY for that one app's tool-call route and that one session's three read routes (`GET /sessions/:id`, `/events`, `/events/stream`); every other route, and the whole feature when no token is presented, is unaffected. New modules: `app-link-token.ts` (HMAC mint/verify, persisted `~/.agentproto/keys/app_link_hmac` key), `telegram-init-data.ts` (Telegram WebApp signature verification), `app-link-auth.ts` (the identity-bound exchange, single-use link tokens, audit logging), `app-link-gate.ts` (the HTTP-level predicates).

### Patch Changes

- 8b4135e: Docs: describe system-prompt channels per adapter, the sandbox-gone restart default, and the box-login bridge.

## 1.7.5

### Patch Changes

- Updated dependencies [fe3c879]
  - @agentproto/agent@0.3.0
  - @agentproto/mastra@0.2.17

## 1.7.4

### Patch Changes

- Updated dependencies [dee54cb]
  - @agentproto/workflow-loader@0.2.8

## 1.7.3

### Patch Changes

- 0e8cd2d: Serve stale app UI bundles while rebuilding; skip mtime-only rebuilds
- Updated dependencies [4e32602]
  - @agentproto/workflow-loader@0.2.7

## 1.7.2

### Patch Changes

- Updated dependencies [86f43d7]
  - @agentproto/workflow-loader@0.2.6

## 1.7.1

### Patch Changes

- 68c5ce6: Document ui.renders and terminal session list pagination.
- Updated dependencies [ab367ec]
  - @agentproto/tool@0.5.1
  - @agentproto/driver-cli@0.2.4
  - @agentproto/driver@0.3.2
  - @agentproto/driver-http@0.1.12

## 1.7.0

### Minor Changes

- b7ddf13: New optional `ui.renders`: the subset of `ui.tools` whose results the host displays in the app's UI. A server publishing the app as an MCP App links those tools to the app's `ui://` resource. `defineApp` rejects ids missing from `ui.tools` and duplicates; the field round-trips through `emit` and `loadAppHandle`.

### Patch Changes

- Updated dependencies [5b021a8]
  - @agentproto/tool@0.5.0
  - @agentproto/driver-cli@0.2.3
  - @agentproto/driver@0.3.1
  - @agentproto/driver-http@0.1.11

## 1.6.2

### Patch Changes

- 0ea7fe9: Store listing fields on app-catalog/v1 entries (all optional): `tagline`, `longDescription` (markdown), `screenshots` ({url, alt, width?, height?}), `categories`, `homepage`, `repository`, alongside the existing `icon` and `publisher`. Declared in an APP.md `store:` block and written by `agentproto app pack --release --entry`, which checks the media and copies them to `media/<appId>/<version>/` next to the entry (`--media-base-url` relocates them). `agentproto catalog verify` checks the listing (limits, https, alt text, image format and size); `--local-media <prefix>=<dir>` reads media from a checkout. `store/` is left out of release bundles. A relative top-level APP.md `icon` is no longer copied into a public entry.

## 1.6.1

### Patch Changes

- 8e87002: `app pack --release` also leaves out tests (root `test/` and `tests/`, `__tests__/` and `*.test.*` / `*.spec.*` anywhere), the root `README.md`, `CHANGELOG.md` and `CONTRIBUTING.md`, and repo tooling config (`.github/`, editor folders, `tsconfig*.json`, test runner and lint configs). `LICENSE` still ships.

## 1.6.0

### Minor Changes

- 1487de1: `.agentapp` packing honors an APP.md `package` block (`include` / `exclude` globs, `stripBuild`) and stages only the selected files. New `agentproto app pack --release` builds the UI first, drops dev-only files (UI sources, docs, data, scripts, logs, source maps, env files), fails when the built `ui.path` is missing, and strips `ui.build` from the packed APP.md.
- c72bbd4: Apps can call each other. `requires.apps` entries may now be objects
  (`{ id, version?, workflows? }`) next to bare ids, and `exposes.workflows`
  declares which workflows an app lets other apps run. A new `app_call` MCP verb
  runs an exposed workflow on behalf of an installed consumer app, checking the
  declared dependency, the workflow allowlist, the provider's exposed workflows
  and its installed version range, and returns the workflow's output with a
  distinct error code per refusal. `app_apply` also refuses an app whose declared
  dependency version range is not satisfied. The daemon is local-trust:
  `callerAppId` is a declaration check, not an authentication boundary.

### Patch Changes

- 530c3ec: Docs-only correction in the README: the `ui.build` captured-output path is now `~/.agentproto/logs/app-ui-build/<app>-<hash>.log` instead of `<appDir>/.agentproto/ui-build.log`, matching the runtime change in this PR.

## 1.5.0

### Minor Changes

- eb3d4d5: Add ui.extensions.openai v1 contract (entrypoints/icons/display/mentions) with emit/load round-trip

## 1.4.1

### Patch Changes

- Updated dependencies [a68d1d6]
- Updated dependencies [4243c75]
  - @agentproto/driver@0.3.0
  - @agentproto/tool@0.4.0
  - @agentproto/driver-cli@0.2.2
  - @agentproto/driver-http@0.1.10

## 1.4.0

### Minor Changes

- d9cd5d7: Install apps from a git URL or a `.agentapp` and keep them in sync. `@agentproto/app-kit` now exports the AIP-53 bundle core (`packApp`, `unpackApp`, `aggregateSha256`, `collectFiles`, `isManifest`, `AgentAppPackError`), lifted out of the CLI with no behaviour change (unpack additionally refuses a manifest listing paths outside the bundle root). The runtime's `app_install` accepts exactly one of `{dir}`, `{url, ref?, subdir?}` (shallow git clone) or `{url}`/`{file}` for a `.agentapp`, installs remote sources under `<state dir>/apps/<slug>` with an atomic swap that keeps the data dir and survives a failed install, and records `InstalledApp.source` (`local` / `git` sha / `agentapp` sha256+version), surfaced by `app_list` and `app_status`. New `app_resync {appId}` compares the source (`git ls-remote` / re-downloaded bundle digest) and reinstalls when it changed. The CLI gains `agentproto app install <dir|url|file.agentapp> [--ref] [--subdir]` (URL/bundle installs are executed by the daemon) and `agentproto app resync <appId>`; `app pack`/`unpack` are now thin wrappers over app-kit.
- 6a1bedc: App-spawned sessions (`app_run`, and workflow agent steps whose workflow carries an `appId`) now get filesystem zones: the installed app source is read-only, the run workspace and app `data/` dir are writable, everything else is denied. Enforced on the daemon's own file/command tools always; on the harness's native tools (claude-code) via `@agentproto/command-sandbox` zoned mode plus host `CLAUDE.md`/`AGENTS.md` exclusion when the adapter and OS sandbox support it. Apps opt into `boundaries: { enforce: "required" }` in `defineApp`/`APP.md` to refuse a spawn instead of silently downgrading when native enforcement isn't available.

### Patch Changes

- dfeebb6: APP.md gains optional `placement`, `requires` (object form: browser/fs/gpu/secrets/apps; the flat app-id array still works), `exposes` and `accepts` keys, validated in `defineApp` and `loadAppHandle`, surfaced on `AppHandle`, and round-tripped by `emit`. Semantics only; no scheduling behavior.
- 461df5e: Package-metadata refresh accompanying the vendored-specs resync (PR #1554): homepage URLs and keyword tags renumbered to the ratified AIP numbers (app-kit/apps → AIP-53, mastra → AIP-52, define-doctype → AIP-56, wallet → AIP-49), a stale agentik.net homepage corrected (redaction), new keyword tags (pair-client → AIP-59, runtime → AIP-46/AIP-58), and test/doc-comment updates replacing the retired sandbox AIP-61 placeholder with a 9999 fixture number (product, ref), plus bundled SKILL.md renumbering (skill-pack-agentproto) and a routine doc comment aligned with the now-upstream `targetAgent` variant. No runtime behavior changes.
- Updated dependencies [461df5e]
- Updated dependencies [036c9df]
  - @agentproto/mastra@0.2.16
  - @agentproto/driver-cli@0.2.1
  - @agentproto/agent@0.2.5
  - @agentproto/driver@0.2.5
  - @agentproto/tool@0.3.2
  - @agentproto/workflow@0.7.1
  - @agentproto/workspace@0.1.4
  - @agentproto/driver-http@0.1.9
  - @agentproto/workflow-loader@0.2.5

## 1.3.1

### Patch Changes

- afe8324: Republish: `peekAppUi`, the `loadAppHandle` re-export, and `loadAppBundledTools` were added in #1470 but never versioned, so the published `1.3.0` predates them. This broke every fresh `@agentproto/cli@1.1.0` install (`SyntaxError: ... does not provide an export named 'peekAppUi'` on `agentproto --version`, since cli's built `cli.mjs` imports it from `@agentproto/app-kit@1.3.0`). Same failure mode as the `0.3.0` republish (auth/app-kit skew, #468/#470) — no code change, version-only.

## 1.3.0

### Minor Changes

- cd00daa: Apps may now bundle their own AIP-14 `TOOL.md` contracts and AIP-30 `DRIVER.md` implementations (`kind: cli`/`http`) under `.agentproto/tools/<id>/TOOL.md` and `.agentproto/drivers/<id>/DRIVER.md`. `loadAppHandle` (app-kit) discovers and loads them; the runtime's `compileWorkflow` seam merges an app's own tools/drivers over the daemon passthrough registry for every `WORKFLOW.md` `tool` step it owns, with an app tool id winning over a daemon tool of the same id. `driver` gains `driverDefinitionFromManifest`, factored out of `driverFromManifest` so kind-specific sugars can build from a DRIVER.md manifest directly. `driver-http`'s non-2xx errors now include a body excerpt, not just the status code.
- d6d86b6: App-bundled kind:cli drivers spawn subprocesses with the app root as cwd, with metadata.cli.cwd override

### Patch Changes

- 4e398a9: Unify the display-mode toggle into `@agentproto/app-client/display-mode`: the panel bridge and the `window.McpApp` bridges now share one installer with host-aware placement (`safeAreaInsets`), theme support, an `optimistic` mode, and `mountToggle` for inline placement. Runtime exports `injectMcpAppBridge` / `MCP_APP_BRIDGE_SCRIPT`; the bridges expose `getHostContext` / `onHostContext` / `displayMode`.
- Updated dependencies [cd00daa]
- Updated dependencies [d6d86b6]
- Updated dependencies [6c68009]
- Updated dependencies [9a5d311]
- Updated dependencies [502f4c9]
  - @agentproto/driver@0.2.4
  - @agentproto/driver-http@0.1.8
  - @agentproto/driver-cli@0.2.0
  - @agentproto/workflow@0.7.0
  - @agentproto/workflow-loader@0.2.4
  - @agentproto/mastra@0.2.15

## 1.2.1

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [c27f0b8]
  - @agentproto/agent@0.2.4
  - @agentproto/mastra@0.2.14
  - @agentproto/workflow@0.6.1
  - @agentproto/workflow-loader@0.2.3
  - @agentproto/workspace@0.1.3

## 1.2.0

### Minor Changes

- 264c4c7: Add an optional `csp.frameDomains` field to app frontmatter/UI types so apps can declare trusted embedding origins; forwarded into the installed-app UI definitions.
- 79991e7: `app serve` now honours APP.md frontmatter `ui.path` when resolving the UI root (falling back to the legacy `.agentproto/ui/`), fails with a clear exit-2 error when the resolved UI root is missing, and sandbox app serves carry the in-box serve-log error text on `SessionAppServeInfo.message`. Adds exported `resolveAppUIRoot` (app-kit), `createAppServeRequestHandler` (cli), and `serveLogPath`/`extractServeError` (runtime).

## 1.1.1

### Patch Changes

- Updated dependencies [c809f12]
  - @agentproto/workflow@0.6.0
  - @agentproto/workflow-loader@0.2.2
  - @agentproto/mastra@0.2.13

## 1.1.0

### Minor Changes

- 66f73d9: **AIP-53 rule 7**: Enforce absolute filesystem paths for `artifact.path` and `skill.path` in `defineApp`. Relative paths have no defined base at emit time and are now rejected with descriptive error messages.

  **AIP-15 × AIP-41**: Add optional `routines` field to WorkflowDefinition for declaring ROUTINE.md-driven schedules (preferred form) alongside legacy `triggers: [{ kind: schedule }]` support. Introduces new `RoutineRef` type supporting `ref`, `file`, and `inline` variants.

### Patch Changes

- 81752fa: Update upstream dependencies for improved compatibility and stability: @anthropic-ai/claude-agent-sdk (0.3.263), @mastra/core (1.64.0), @mastra/memory (1.28.2), @types/react-dom (19.2.7), and @tauri-apps/plugin-opener (2.5.5).
- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [66f73d9]
- Updated dependencies [81752fa]
- Updated dependencies [2f37e7b]
  - @agentproto/workflow@0.5.0
  - @agentproto/mastra@0.2.12
  - @agentproto/agent@0.2.3
  - @agentproto/workflow-loader@0.2.1
  - @agentproto/workspace@0.1.2

## 1.0.0

### Major Changes

- d66ffe3: app-kit: Remove typed support for the book/library contract (AppLibraryDefinition, AppLibraryBook). The library.books convention now lives as untyped APP.md frontmatter — apps that need the book contract hand-write it directly without type validation.

  cli: Update comments to reflect that app-kit has no typed support for the library.books convention; CLI continues to read it directly from frontmatter.

### Minor Changes

- 4d01e5c: Add the "book contract" — optional `category` + `library.books` fields to app definitions, allowing apps to self-identify as book bundles for catalog/library substrates. Includes validation, round-trip support, and a new `--template book` option in create-agentproto-app, bundled with an `install-agentproto-app` skill for tier-1 installs.

### Patch Changes

- Updated dependencies [c4bff00]
- Updated dependencies [f9e21fd]
- Updated dependencies [c4ebbd3]
- Updated dependencies [a48dc03]
- Updated dependencies [ece3cae]
- Updated dependencies [e7e9261]
  - @agentproto/workflow@0.4.0
  - @agentproto/workflow-loader@0.2.0
  - @agentproto/mastra@0.2.11
  - @agentproto/agent@0.2.2
  - @agentproto/workspace@0.1.1

## 0.8.0

### Minor Changes

- 8215419: Give installed apps a data directory distinct from their source directory. The `app_data_*` plane now anchors to `InstalledApp.dataDir` (default `<dir>/data`) rather than the app's `dir`. Custom data directories are set with `app_install {dataDir}` / `agentproto app install --data-dir`, or hinted by APP.md `data: { dir }`. Full backward compatibility: pre-dataDir files under `<appDir>` are still found via fallback; under the default layout the legacy `data/` spelling is collapsed so existing paths continue to work.
- e655351: Support UI-only apps in app-kit; move builtin daemon panels into @agentproto/apps

### Patch Changes

- @agentproto/mastra@0.2.10

## 0.7.1

### Patch Changes

- Updated dependencies [f0c51a7]
  - @agentproto/agent@0.2.2
  - @agentproto/workflow@0.3.1
  - @agentproto/workflow-loader@0.1.5
  - @agentproto/workspace@0.1.1
  - @agentproto/mastra@0.2.9

## 0.7.0

### Minor Changes

- 0097d36: Add a new opt-in, read-only external filesystem plane for installed apps: an app can declare `externalReadRoots` (a manifest field on `AppDefinition`/`AppHandle`/`AppFrontmatter`/`InstalledApp`) to be granted read access to a real host folder outside the daemon's sandbox — e.g. a user's actual `~/Downloads/applications` — without touching the existing app-data (app-owned dir) or fs-tools (workspace-root) planes.

  Each root is `~`-expanded, resolved absolute, and validated to exist as a real directory at install time (`app_install`/`app_apply` fail fast otherwise). Two new MCP tools (`app_external_list`, `app_external_read`) and a new `GET /apps/:appId/external-blob?root=&path=` HTTP route read from a granted root only when the caller's `root` argument is an exact match — no prefix/fuzzy matching. `app_external_read` serves only an allowlist of text-ish extensions under a 2MB cap; binary content (PDFs, images, …) streams through the HTTP route instead. There is no write or delete tool for these roots anywhere in the daemon.

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

- Updated dependencies [e2314b3]
- Updated dependencies [b95e23b]
- Updated dependencies [b1a8b7e]
  - @agentproto/mastra@0.2.8
  - @agentproto/workflow@0.3.0
  - @agentproto/workflow-loader@0.1.4

## 0.6.1

### Patch Changes

- e418ec7: Documentation updates for new jcode adapter, MCP tool families, configuration enhancements, and Mastra adapter API changes.

## 0.6.0

### Minor Changes

- 33e97d3: Add skill surface to defineApp/emit and app_skill_get validation
- d22fec5: Add artifact surface to defineApp/emit for Cowork artifact registration

### Patch Changes

- 3d54f15: Add `agentproto app serve` command for serving app UIs as standalone webapps with MCP connectivity. Introduces optional `ui.port` field to AppUiDefinition, implements a static HTTP server with bridge script injection, and establishes MCP client proxying through a reserved `/__agentproto/tool-call` endpoint.
- Updated dependencies [bd5faae]
  - @agentproto/mastra@0.2.7

## 0.5.1

### Patch Changes

- 69e97d9: Documentation sync: version bumps, turn-liveness watchdog config details, UI surfaces/artifacts/dev-launch config examples, and agentproto-apps-sync binary documentation.
- Updated dependencies [e68c999]
  - @agentproto/mastra@0.2.6

## 0.5.0

### Minor Changes

- 4b73e28: Add UI, artifacts, and dev-launch configuration support to app-kit. Apps can now declare HTML surfaces, artifact types, and dev-launch configurations that are carried through emit/load and integrated into the runtime app registry.
- b098b52: Add UI, artifacts, and dev-launch configuration support to app-kit. Apps can now declare HTML surfaces, artifact types, and dev-launch configurations that are carried through emit/load and integrated into the runtime app registry.

## 0.4.0

### Minor Changes

- 47ca357: Add `loadAppHandle(dir)` function to load previously emitted app bundles, and support optional app identity fields (id/name/version/description) in `defineApp`. The emit now always writes a root `APP.md` index manifest that a future daemon `app_install` can discover and consume.
- 2b379e9: Add app dependency management and scope mount tracking. Introduces `requires` field on apps to declare dependencies, new MCP tools (`app_apply`, `app_unapply`, `app_list_applied`) for managing app mounts to scopes, HTTP endpoints mirroring the tools, and AppRegistry enhancements for persistence of applied mounts with dependency validation.

### Patch Changes

- 087f0ea: Declarative agent steps for AIP-15 workflows (WP-B4): author `kind:"agent"` steps with `agent.ref` (app-scoped agent ids) that resolve at compile time to concrete adapters + spawn options. Includes app installation/lifecycle tools (`app_install`, `app_run`, `app_list`, `app_status`, `app_stop`) for managing installed-app state and running agents as live sessions. Tool-id validation now shifts from STEP-DISPATCH time to INSTALL time, listing all missing ids upfront instead of failing one-at-a-time.
- Updated dependencies [087f0ea]
  - @agentproto/workflow@0.2.0
  - @agentproto/workflow-loader@0.1.3
  - @agentproto/mastra@0.2.5

## 0.3.2

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
- Updated dependencies [c1399f3]
  - @agentproto/mastra@0.2.4

## 0.3.1

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- Updated dependencies [23fa73e]
- Updated dependencies [04aedad]
  - @agentproto/workflow@0.1.1
  - @agentproto/mastra@0.2.3

## 0.3.0

### Minor Changes

- a0b94fd: Republish auth (eligibleProfiles export, added in #470 but never versioned)
  and app-kit (WorkspaceShorthand / optional `workspace` on AppDefinition,
  added in #468 but never versioned) to fix npm publish skew — #468 touched
  `packages/app-kit/src/types.ts`, not `@agentproto/workspace`, so app-kit is
  the stale published artifact, not workspace.

## 0.2.0

### Minor Changes

- e3bacf3: Add app-kit pick()/only, fix content-team tools, self_inspect discovers app-emitted agents
