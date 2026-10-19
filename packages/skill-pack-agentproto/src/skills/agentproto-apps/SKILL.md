---
name: agentproto-apps
description: >-
  Author, develop, and package an agentproto APP (AIP-53) — the real CLI
  path: `agentproto app init` → edit `.agentproto/` (APP.md, agents/,
  workflows/, ui/) → `agentproto app validate` → `agentproto app dev` /
  `build` / `serve` → `agentproto app install` → `agentproto app pack`.
  Covers the canonical file layout, APP.md frontmatter, the templates
  (react-ts | vanilla | book | trame), validating all findings at once, and
  shipping a verified .agentapp bundle. Use when asked to "build an agent
  app", "scaffold/package an agentproto app", or debug why an app won't
  validate. For the daemon install/run/data lifecycle that follows, see
  the `ap-apps` skill.
metadata:
  tags: agentproto, app, aip53, authoring, scaffold, validate, app init, app dev, app pack
  aip3:
    uses: ["agentproto", "ap-apps"]
---

# Authoring an agentproto APP (AIP-53)

An **app** is a directory whose `.agentproto/APP.md` (schema `app/v1`)
declares one or more AIP-42 agents, the AIP-15 workflows they run, and an
optional UI. You author that bundle with plain files inside `.agentproto/`
— there is no code builder or emit step, and no `agents/` folder at the app
root; everything the manifest references lives under `.agentproto/`. This
skill is the authoring plane; installing/running/data live in the `ap-apps`
skill.

## The path

```
agentproto app init <template> [dir]   # scaffold (react-ts | vanilla | book | trame)
#   … edit .agentproto/APP.md, .agentproto/agents/, .agentproto/workflows/, ui/
agentproto app validate [dir] [--json] # all findings at once, exit 0 = sound
agentproto app dev <appDir>            # Vite dev server + live McpApp bridge (ui/ projects)
agentproto app build <appDir>          # build ui/ into .agentproto/ui/ (no-op for static UIs)
agentproto app serve [appDir]          # serve the built/static .agentproto/ui/ standalone
agentproto app install <appDir> [args] # register with the daemon (validates) or remote source
agentproto app pack <appDir> [--release] [--out <path.agentapp>]  # verified .agentapp
```

Template `trame` ships the most: agent step + gate workflow, stage-board UI,
`data/DATA.md`, `gates/`, `scripts/verify.mjs` wired as APP.md
`verify.command`. `vanilla`/`book` are the hand-written no-build-chain shape
(single-file `.agentproto/ui/index.html`, no root `package.json`); `react-ts`
adds a Vite + TanStack `ui/` source project.

## Layout that `app init` generates

```
<appDir>/
  .agentproto/
    APP.md                          # manifest — schema: app/v1, id, agents[], workflows[], ui
    agents/<id>/AGENT.md            # AIP-42 agent manifest + system-prompt body
    workflows/<id>/WORKFLOW.md      # AIP-15 workflow manifest (steps, cost_class, …)
    ui/index.html                   # static UI (vanilla/book/trame) — or ui/ source project
  ui/                               # Vite source project (react-ts template only)
  data/                             # durable app_data_* storage (trame ships data/DATA.md)
```

`APP.md` frontmatter real example (from `app init trame`):

```yaml
---
schema: app/v1
id: my-app
name: My App
version: 0.1.0
description: >-
  My App — scaffolded by `agentproto app init` (trame template)
agents:
  - id: my-app-agent
    path: .agentproto/agents/my-app-agent/AGENT.md
workflows:
  - id: my-app-flow
    path: .agentproto/workflows/my-app-flow/WORKFLOW.md
data:
  dir: data
ui:
  path: .agentproto/ui/index.html
  title: My App
  tools: [app_run, app_status, app_stop, app_list, app_data_read, app_data_write, app_data_list]
verify:
  command: node scripts/verify.mjs
---
```

- Agent/workflow entries reference manifest files by **relative path**; the
  folder names are free-form (the scaffold slug matches the `id`).
- `ui.tools` is an **allowlist** — `app_tool_call` refuses any tool id not
  listed; extend it when the UI calls a new daemon tool.
- Optional `data: {dir}` sets the durable app_data_* base (default
  `<appDir>/data`).

Replace the scaffolded placeholders with the agent's real prompt, tool
allowlist, and the workflow's real steps; the APP.md prose and the
AGENT.md body stay stubs until you do. `app validate` reports every
finding in one pass.

## Minimal working example

```bash
agentproto app init vanilla notes-digest
cd notes-digest
# replace agents/notes-digest-assistant/AGENT.md prompt + workflows/
# notes-digest-flow/WORKFLOW.md steps with the real task; extend APP.md
# ui.tools for any new daemon tool the agents/UI need
agentproto app validate .          # → "is a valid agentproto app", exit 0
agentproto app install .            # → registers notes-digest in ~/.agentproto/apps.json
agentproto app pack .               # → notes-digest-<version>.agentapp
```

Run it: static UIs (`vanilla`/`book`/`trame`): `agentproto app serve .`.
Vite UIs: `pnpm install`, then `agentproto app dev .` while iterating and
`agentproto app build .` before pack — `app pack --release` runs
`ui/`'s build itself when missing/stale and drops dev-only files from the
bundle.

## Gotchas

- `agentproto app init`'s first argument is the **template**, the optional
  second one the target dir: `agentproto app init trame my-app`.
- `app dev` requires `ui/package.json` with a `scripts.dev`; static UIs have
  nothing to compile — use `app serve` (and `app build` is a no-op).
- This repo's root `.gitignore` ignores `.agentproto/` at any depth; for a
  first-class app bundle that dir IS the deliverable —
  `git add -f <appDir>/.agentproto` to commit it. The `react-ts` template's
  `.gitignore` un-ignores its built `.agentproto/ui/` output.
- `app install` on a real path is idempotent and validates up front
  (workflow `tool` ids against the daemon's table — ALL missing ids at once);
  a git URL or `.agentapp` installs via the running daemon. `--data-dir`
  points durable storage outside the source tree.
- Format gates bite: `cost_class` must be `trivial|metered|expensive` and
  `APP.md`/`AGENT.md`/`WORKFLOW.md` each enforce
  `schema: app/v1` on APP.md and `schema: agent/v1` on AGENT.md + id regexes — prefer the placeholder
  fields over inventing new keys.

## Pointers

- ap-apps — the installed-app lifecycle: app_install/app_run/app_status,
  app_data_* persistence, app_tool_call — everything after install.
- ap-workflows — the workflow engine the bundled WORKFLOW.md files run as.
- extend-agentproto — publishing skills/adapters that the app might need.
