# create-agentproto-app

Scaffold an agentproto agent app: the `.agentproto/` shell (`APP.md`, one
agent, one workflow) plus a `ui/` project — Vite + TanStack Router (hash
history) + TanStack Query + [`@agentproto/app-client`](../app-client) — that
builds to static files in `.agentproto/ui/`.

## Usage

```bash
pnpm create agentproto-app my-app
# or
npx create-agentproto-app my-app
```

```
create-agentproto-app <dir> [--id <@scope/app-id>] [--name <display name>]
                            [--template react-ts|vanilla|book] [--json]
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--id` | the target dir's slug (no scope) | written to `.agentproto/APP.md` `id` |
| `--name` | title-cased slug | written to `.agentproto/APP.md` `name` and the UI title |
| `--template` | `react-ts` | `react-ts` (Vite + TanStack `ui/`), `vanilla` (hand-written static UI, no build step), or `book` (`vanilla`'s shape plus the APP.md book contract + an install skill) |
| `--json` | off | prints `{appDir, id, name, slug, template, fileCount}` instead of a human summary |

`<dir>` must not exist, or must be empty — the scaffolder refuses (exit 2)
rather than overwriting an occupied directory.

## What gets written

```
my-app/
├── package.json            # private; dev/build/serve → `agentproto app <verb> .`
├── pnpm-workspace.yaml      # packages: ["ui"] — one `pnpm install` at the root
├── .gitignore
├── .agentproto/
│   ├── APP.md               # schema app/v1 — id, name, one agent ref, one workflow ref, ui
│   ├── agents/<slug>-assistant/AGENT.md
│   ├── workflows/<slug>-flow/WORKFLOW.md
│   └── ui/index.html        # pre-built placeholder so `serve`/`pack` work before the first build
└── ui/                       # Vite + React + TanStack Router + TanStack Query source
    ├── package.json
    ├── vite.config.ts        # base "./", outDir "../.agentproto/ui", emptyOutDir, /__agentproto proxy
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── main.tsx
        ├── router.tsx         # createHashHistory + two routes (dashboard, about)
        ├── standalone-tools.ts
        └── routes/{dashboard,about}.tsx
```

`<slug>` is always derived from `<dir>`'s basename (lowercased, hyphenated) —
it's what names the on-disk agent/workflow folders, independent of a custom
`--id`. `__APP_ID__` / `__APP_NAME__` / `__APP_SLUG__` tokens are substituted
in every template file's contents *and* path segments.

## Why hash routing

The daemon, `agentproto app serve`, and the MCP-Apps panel all serve a
built app as plain static files with no server-side rewrite rules. A single
`index.html` plus `createHashHistory()` routes works from any subpath (or
even `file://`) without emitting per-route HTML — see `ui/src/router.tsx`
in the scaffolded output.

## Next steps after scaffolding

```bash
cd my-app
pnpm install
agentproto app dev .     # Vite dev server + a bridge proxy at /__agentproto
# or, once you're ready to ship the static build:
agentproto app build .
agentproto app serve .
```

See the [create-agentproto-app guide](../../docs/cli/guides/create-agentproto-app.md)
and [`agentproto app`](../../docs/cli/verbs/app.md) for the full CLI surface.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
