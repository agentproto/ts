---
name: ap-apps
description: Install and run agentproto APPs (AIP-42 bundles of agents and workflows) — app_install, app_apply/unapply to scopes, app_run with concurrent or sequenced agents, app_status/app_stop, and app data/artifact/skill reads. Trigger when asked to install or run an agentproto app, bundle, or app-kit package.
---

# ap-apps

## When to use

- An app bundle (`.agentproto/APP.md` — agents + WORKFLOW.md files) needs installing, applying to a scope, or running.
- You must run an app's agents one-at-a-time (scout → tailor pipelines) or all at once.
- You need to read/write an app's scoped data or fetch its artifact/skill content.

## Install → apply → run

```json
// 1. Install from the emitted app directory (validates ALL WORKFLOW.md tool ids up front)
app_install({ "dir": "/path/to/app" })
// → { "appId": "@agentproto/code-team", ... }

// 2. Apply to a scope (default 'root') — makes its capabilities available there
app_apply({ "appId": "@agentproto/code-team" })

// 3. Run: all agents concurrently (default)
app_run({ "appId": "@agentproto/code-team", "prompt": "Review the auth module" })

//    ...or one-at-a-time in order — each waits for the previous to finish
app_run({ "appId": "@agentproto/scout-tailor",
  "sequence": ["scout", "tailor"] })

// 4. Poll / stop
app_status({ "appRunId": "run_..." })   // live session descriptors + workflow runs
app_stop({ "appRunId": "run_..." })     // kills every session in the run, marks ended
```

`app_install` validates every WORKFLOW.md `tool` id against the daemon's dispatchable tools **all at once** — you get the full missing-id list, not one failure at a time. Re-installing the same appId upserts. The `mastra-agent` adapter must resolve for agent steps.

## Catalog, artifacts, data

```json
app_catalog({})                                        // browsable apps merged with install status
app_list({})                                           // installed apps + run history
app_artifact_get({ "appId": "..." })                   // artifact HTML (daemon exposes it, host writes it)
app_skill_get({ "appId": "..." })                      // skill files (utf-8; binaries skipped with a warning)

app_data_list({ "appId": "...", "dir": "data/jobs" })  // entries under the app dir
app_data_read({ "appId": "...", "path": "data/state.json" })
app_data_write({ "appId": "...", "path": "data/state.json", "content": { "ok": true } })
```

`app_data_*` paths are app-relative with traversal guards; `.json` paths stringify the value. For granted external read roots, `app_external_list` / `app_external_read` work the same way (read-only). `app_tool_call` invokes one of the app's UI-exposed tools by id.

## Lifecycle

```json
app_unapply({ "appId": "..." })     // remove from scope (refuses if another applied app requires it)
app_uninstall({ "appId": "..." })   // remove the record (refuses while applied or a run is alive)
```

## Gotchas

- A stale install (app dir moved, workflow renamed) self-heals on the next `app_run` — paths are refreshed first. But the clean fix for a *moved* app directory is uninstall + reinstall.
- `app_status` returns BOTH the run's session descriptors AND any workflow runs of the app's bundled WORKFLOW.md files, however those workflows were started.
- One `appRunId` groups all spawned sessions — `app_stop` takes it and kills the whole fan-out.
- Without `sequence`, `app_run` spawns the agents **concurrently** — order matters only via `sequence: [agentIds]`, one-at-a-time with a ~60×2s wait bound per handoff.
- Install validates tool ids but not agent-declared tool refs (workspace tools like `read_file` are the adapter's own business — see `unvalidatedAgentTools` in the result).

## Pointers

- agentproto — daemon overview; AIP-42 app bundle spec.
- ap-workflows — the workflow engine app WORKFLOW.md files compile into.
- ap-spawn-agent — what an app run does under the hood, one spawn per agent.
- pb-build-app — packaged authoring workflow for new apps.
