---
name: agentproto-apps
description:
  Operate and build Agentproto apps — AIP-42 app bundles (`defineApp().emit(dir)`,
  APP.md + agents/ + workflows/ + ui/) and their daemon lifecycle (app_install,
  app_apply, app_run, app_status, app_stop) plus the app-scoped durable data
  plane (app_data_read/write/list/migrate). Covers serving one with a UI
  (`agentproto app serve` → window.McpApp bridge → /mcp), app-scoped
  path-traversal-safe storage under the installed app dir, sequential
  scout-then-tailor-style app_run sequencing, and model/harness pass-through.
  Use when asking to "build an agent app", "wire an app UI / app_run", "how do
  apps persist data", "run an app's agents in order", or debugging an installed
  app (job-application-kit, …).
metadata:
  tags: agentproto, app, aip42, udashboard, app_run, app_data, defineApp, app serve
  aip3:
    uses: ["agentproto"]
---

# Agentproto apps (AIP-42)

A **packaged app** is a directory that ships one or more AIP-42 agents, the
AIP-15 workflows they run, and (optionally) a single-file web UI, emitted under
`<dir>/.agentproto/` by `defineApp().emit(dir)`. The daemon installs, applies,
runs, and persists them. This skill is the app plane on top of the base
`agentproto` skill (sessions/drivers live there).

## Anatomy — what an app dir contains

```
<appDir>/
  .agentproto/
    APP.md                            # frontmatter: id, agents[], workflows[], ui{path,tools}
    agents/<id>/AGENT.md              # AIP-42 agent manifests
    workflows/<id>/WORKFLOW.md        # AIP-15 workflow manifests
    ui/index.html                     # single-file dashboard (CSS+JS inline)
  data/                               # default data dir (app_data_* writes here)
<dataDir>/                            # …or wherever `app_install {dataDir}` /
                                      # `app install --data-dir` pointed it
```

`APP.md` frontmatter (`schema: app/v1`, `id`, `agents: [{id,path}]`,
`workflows: [{id,path}]`, `ui: {path, title, tools: [...]}`, optional
`data: {dir}` — the default data dir, relative to the app dir). The `ui.tools`
array is an **allowlist** — `app_tool_call` REFUSES any tool id not in it, so
when the UI calls a new daemon tool (e.g. `app_data_read`), add it there.

> **Gotcha:** this repo's root `.gitignore` ignores `.agentproto/` by default
> (it targets agent-scoped scratch). For a first-class app bundle the
> `.agentproto/` dir IS the deliverable — `git add -f <appDir>/.agentproto` to
> commit it.

## The app lifecycle (daemon verbs)

- **`app_install {dir}`** — validates the app (`loadAppHandle`), cross-checks
  every WORKFLOW.md `tool` step id against the daemon's registered tools
  (reports ALL missing at once), and checks the agent adapter resolves. Upserts
  by `appId`. Re-installing refreshes the record.
- **`app_apply {appId, scopeId?, dir?}`** — makes the app's capabilities
  available in a scope; installs first if `dir` given and not already installed;
  validates `requires` deps are applied. Idempotent.
- **`app_run {appId, agents?, sequence?, prompt?, cwd?, model?, harness?, adapter?}`** —
  spawns one live session per agent under a fresh `appRunId`. `agents` runs them
  CONCURRENTLY. `sequence: [id, ...]` runs them ONE-AT-A-TIME in order (each
  awaited to a terminal session state before the next), for scout→tailor-style
  dependency chains — both under one appRunId. Pass `model`/`harness` (or
  `adapter`) to select the runner for every spawn.
- **`app_status {appRunId}`** — returns the run's session descriptors + its
  workflow runs. As of the sequential-run work, `app_status` LAZILY reconciles:
  if the stored run status is `running` but every session is terminal, it
  reports `ended` (with a synthesized `endedAt`) — so concurrent runs are also
  observed to conclude instead of hanging forever at `running`.
- **`app_stop {appRunId}`** — kills the run's sessions and marks it terminal.
- **`app_list`** — installed apps with a run-history summary (includes
  `adapter`/`harness`/`model` when set on the run).
- `app_uninstall` / `app_unapply` / `app_list_applied` / `app_catalog` /
  `app_skill_get` / `app_artifact_get` — installation/uninstall and catalog.

**Terminal states:** run-level status is `running | stopped | ended | failed`.
A session is terminal at its descriptor status ∈ `ended|exited|done|failed|
stopped|killed`. The UI's "is it done" check should accept the run wrapper
(`ended`/`done`/`endedAt`) OR any terminal session status — never only the
wrapper, since a completed run may still read `running` until reconciliation.

## The app-scoped data plane (app_data_*)

Generic `fs-*` tools are **workspace-rooted** — unsafe/incompatible for
installed-app storage. Apps persist through the app-scoped surface, anchored to
the installed app's **data dir** (`InstalledApp.dataDir`, default `<dir>/data`,
persisted in `~/.agentproto/apps.json`) with **path-traversal protection**:
`resolveAppDataPath` rejects absolute paths, drive-letter prefixes, and any
`..`/symlink escape; every failure returns an MCP error envelope containing
`traversal`.

**Data dir ≠ source dir.** `app_install {dir, dataDir?}` (CLI: `agentproto app
install <appDir> --data-dir <path>`) points the plane at a directory outside
the source tree — that's where multi-GB generated output belongs. Precedence:
explicit `dataDir` → the previously installed one (a bare re-install never
moves data) → APP.md `data: {dir}` (relative to the app dir) → `<dir>/data`.
`app_list` shows it. Resolution rule for an app-relative path:

1. resolves under `dataDir`;
2. under the default layout (`<dir>/data`) a leading `data/` is the legacy
   spelling and is dropped — `data/trips/x.json` ≡ `trips/x.json`;
3. if the path (or its top-level folder) exists only under the source `dir`
   (a pre-dataDir install), it resolves there — reads find it, writes update it
   in place, `app_data_list` merges both views. New paths land under `dataDir`.

Address files at the new base (`trips/<id>/brief.json`, not
`data/trips/...`). Reserved for later: a `store.sqlite` in `dataDir` behind an
`app_data_query` tool — not there yet.

- **`app_data_read {appId, path}`** → `{appId, path, exists, content}` —
  `.json` paths parse `content`; others return raw text. `exists:false` when
  absent. Never leaks the host absolute path (returns the relative `path`).
- **`app_data_write {appId, path, content}`** → `{appId, path, size}` —
  JSON-stringified (pretty) for `.json`; `{text}` otherwise. mkdir -p parent,
  atomic tmp+rename. Best-effort, never crashes.
- **`app_data_list {appId, dir?}`** → `{appId, dir, entries:[{name,type,size}]}` —
  missing dir → empty entries (not an error).
- **`app_data_migrate {appId, force?}`** → one-time import of a legacy data
  shape into the durable layout; idempotent via `data/state.json` (`force`
  re-runs). Reports `{migrated, jobCount, dossierCount, skippedFolders, alreadyMigrated?}`.

**Durable layout convention** (adapt to the app; the Job Application Kit uses,
all relative to the data dir):
```
<dataDir>/jobs/<jobId>.json
<dataDir>/search/<searchRunId>.json
<dataDir>/rankings/<rankingRunId>.json   (+ rankings/latest.json for the list)
<dataDir>/state.json
<dataDir>/applications/<jobId>/{application.json, job.json, cv.json, cover.md, form-answers.md}
```
Normalize legacy records on migrate: ensure `id` === `jobId` (both present) and
derive `applyUrl` from `url` when missing. Durable files SURVIVE browser reload;
localStorage is for harmless preferences only, never as the source of truth.

## Serving the UI (the bridge)

`agentproto app serve <appDir>` (or the equivalent in-process host) serves
`<appDir>/.agentproto/ui/index.html` with a `window.McpApp` bridge whose
`callTool` POSTs to the daemon's `/mcp` endpoint (same-origin JSON
`/__agentproto/tool-call` route bridged by the serve host). The in-page JS
dispatches through a wrapper:
```js
window.McpApp.connect().then(bridge => {
  callTool = bridge.callTool
  // appData migrate → list → read, then render
})
```
App UI tool calls go through `app_tool_call {appId, tool, args}` (enforced by
the `ui.tools` allowlist), so every tool the UI uses must be allowlisted in
APP.md. If the bridge is absent the UI should fall back to a standalone/mock
mode instead of crashing.

## Recipe — build/wire an app UI against durable data (minimal)

1. Author the app bundle under `<appDir>/.agentproto/` (APP.md + agents +
   workflows + ui/index.html). Use `defineApp().emit(dir)` if authoring in TS.
2. `app_install {dir}` then `app_apply {appId}`.
3. In the UI, on bridge connect, call `app_data_migrate {appId}` once, then
   `app_data_list`/`app_data_read` to render datasets from disk (NOT
   localStorage). Allowlist `app_data_*` in APP.md `ui.tools`.
4. Wire user-facing model/harness pickers into `app_run` args (`model`,
   `harness`) — they're mirrored onto the run and observable via `app_list`/
   `app_status`.
5. For scout→tailor: call `app_run {sequence:["scout","tailor"], model, harness}`
   and poll `app_status` until `ended` (or any session terminal).

## Test an installed app (the smoke path)

1. Serve it: `agentproto app serve <appDir>` and open the printed URL.
2. Fresh load runs `app_data_migrate` once → dashboard populates from
   `data/...` on disk — confirms recovery/migration (not a zero dashboard).
3. From devtools assert path-traversal is rejected:
   `callTool("app_tool_call",{appId,tool:"app_data_read",args:{path:"../etc/passwd"}})` → `traversal` error.
4. Assert the model/harness controls surface and that a Full Pipeline run
   reaches a terminal `ended` state (not stuck `running`).
5. Headless: `app_data_migrate`/`app_data_*` are covered by
   `packages/runtime/src/__tests__/app-data.test.ts`; `app_run` sequencing +
   terminal reconciliation by `app-tools.test.ts`. Run
   `pnpm --filter @agentproto/runtime test`.

## Do / don't

- **Do** persist via `app_data_*`; path-traversal it.
- **Do** keep UI tool calls allowlisted in APP.md.
- **Do** treat a run done when wrapper OR any session is terminal.
- **Don't** treat `app_data_*` like generic fs-tools (they're app-scoped).
- **Don't** use localStorage as the data source of truth.
- **Don't** run `app_run` agents concurrently when the flow is dependency-ordered
  — use `sequence`.