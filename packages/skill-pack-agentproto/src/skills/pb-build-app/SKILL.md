---
name: pb-build-app
description: Package your agents and workflows as an installable agentproto AIP-42 APP and run it end to end. Trigger for app packaging - 'build an agentproto app', 'bundle my agents', 'install and run an app', 'app_install my workflow bundle'.
---

# pb-build-app — package my agents + workflows as an agentproto APP

## Goal

Turn a folder of agents and workflows into an installable AIP-42 APP: author
it, install it (validation included), apply it to a scope, run its agents,
watch the run, tear it down, and share it.

Prerequisites (reference by name): `ap-apps`, `ap-workflows`,
`ap-spawn-agent` (apps spawn agent sessions under the hood), `ap-lifecycle`.

## Steps

### 1. Author the app directory

Emit with the app-kit builder: `defineApp().emit(dir)` produces the
canonical layout —

```
<dir>/
  .agentproto/APP.md    ← app manifest
  agents/AGENT.md       ← one per agent
  workflows/WORKFLOW.md ← one per workflow
  ui/                   ← optional UI artifact
```

Write real content for AGENT.md briefs and WORKFLOW.md stages; the emitted
skeleton is not the app.

### 2. Install — validation is the gate

```
app_install({ dir: '<ABSOLUTE path to the app dir>' })
```

Validation checks every `WORKFLOW.md` `tool` id against the daemon's
dispatchable tools and reports ALL missing ids AT ONCE (not one at a time).
Fix every reported id and re-install — a successful install returns the
appId. Agent-declared tool refs (e.g. workspace tools like `read_file`) are
the adapter's own business and are never validated here.

### 3. Apply to a scope

```
app_apply({ appId: '<appId>', scopeId: 'root' })
```

Apply makes the app's capabilities available in that scope. Re-applying the
same app updates the timestamp (idempotent). If the app `requires` other
apps, apply those to the same scope first.

### 4. Run the agents

```
app_run({ appId: '<appId>', sequence: ['scout', 'tailor'] })   // ordered stages
app_run({ appId: '<appId>' })                                   // concurrent
```

With `sequence`, agents run ONE-AT-A-TIME — each waits for its predecessor
to reach a terminal state (bounded ~60x2s) — and all live under the SAME
appRunId. Without `sequence`, agents spawn concurrently. The `mastra-agent`
adapter (default) points each spawned session at that agent's emitted
AGENT.md.

### 5. Watch, then stop

```
app_status({ appRunId: '<appRunId>' })   // sessions + workflow runs
app_stop({ appRunId: '<appRunId>' })     // kill every session in the run
```

`app_status` returns live session descriptors plus any workflow runs
belonging to the app; `app_stop` kills everything in the run and marks it
`ended`.

### 6. Share

List the app in the catalog with `app_catalog`, and surface it through the
app store (`app_store` on the Guilde surface) so other scopes can install
it. The installable unit is the emitted directory; the catalog entry is its
index.

## Gotchas

- `app_install` validates workflow tool ids only — agent-declared workspace
  tools are the adapter's concern. A workflow that "installs fine" can still
  fail at STEP-DISPATCH time if it calls a tool the runtime cannot dispatch.
- Re-installing the same appId upserts; `app_run` re-reads the app directory
  first, so a stale install record (paths moved, workflow renamed) is
  refreshed before spawning.
- `app_stop` kills every session in the run — do not mix long-lived side
  sessions you care about into an appRunId.
- The app dir must be re-emitted after edits: install does not watch the
  filesystem.

## Verify

`app_status({appRunId})` shows your agents as live session descriptors with
real ids (not error states) and each workflow stage reaching its expected
terminal state; the app UI artifact renders via `app_artifact_get({appId})`
returning HTML content. When done, `app_stop` leaves the run marked `ended`
with no live sessions.
