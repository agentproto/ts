# Scaffold an app with create-agentproto-app

This guide covers `create-agentproto-app`, the scaffolder for a new
agentproto agent app: the `.agentproto/` shell (an `APP.md`, one agent, one
workflow) plus a `ui/` source project — Vite + TanStack Router (hash
history) + TanStack Query + [`@agentproto/app-client`](https://www.npmjs.com/package/@agentproto/app-client)
— that builds to static files in `.agentproto/ui/`.

> For `agentproto app dev` / `build` / `serve` / `pack` — running the app
> this scaffolds — see [`verbs/app.md`](../verbs/app.md). This guide is only
> about generating the initial project.

---

## 1. Scaffold

```bash
pnpm create agentproto-app my-app
# or, without pnpm:
npx create-agentproto-app my-app
```

```
create-agentproto-app <dir> [--id <@scope/app-id>] [--name <display name>]
                            [--template react-ts|vanilla] [--json]
```

`<dir>` must not exist, or must be empty. The scaffolder refuses (exit 2)
rather than write into an occupied directory.

| Flag | Default |
| --- | --- |
| `--id` | `<dir>`'s slug (lowercased, hyphenated, no scope) |
| `--name` | title-cased slug |
| `--template` | `react-ts` |
| `--json` | off — prints a human summary instead |

The slug is always derived from `<dir>`'s basename, even when `--id` is a
scoped id like `@acme/my-app` — it's what names the on-disk agent/workflow
folders (`.agentproto/agents/<slug>-assistant/`).

### Templates

| `--template` | Shape | Install / build |
| --- | --- | --- |
| `react-ts` (default) | `.agentproto/` shell + a Vite + TanStack Router + TanStack Query `ui/` source project that builds to `.agentproto/ui/` | `pnpm install`, then `agentproto app build` / `app dev` |
| `vanilla` | `.agentproto/` shell + a single hand-written `.agentproto/ui/index.html` (vanilla JS, no build step, no `ui/` dir, no root `package.json`) | none — `agentproto app serve` runs it directly |

Both templates ship the same `.agentproto/APP.md` + one agent + one
workflow shape; only the UI differs. `vanilla` is the shape a hand-written
app like `job-application-kit` uses — pick it when you don't want a Vite
toolchain at all. `agentproto app build` no-ops successfully against a
`vanilla`-scaffolded app (no `ui/package.json` to compile) — see
[`verbs/app.md`](../verbs/app.md#optional-ui-source-project).

### Version stamp

`react-ts`'s `ui/package.json` pins `@agentproto/app-client` to whatever
version this `create-agentproto-app` itself depends on (resolved at
scaffold time from the installed package, not hardcoded) — so a freshly
scaffolded app always starts on a matching, in-lockstep `app-client`
version.

## 2. Install and run

```bash
cd my-app
pnpm install          # pnpm-workspace.yaml wires ui/ in, so one install covers both
agentproto app dev .  # Vite dev server + a same-origin /__agentproto bridge proxy
```

Open the printed dev URL. The dashboard route calls `app_status` through
[`useMcpTool`](https://www.npmjs.com/package/@agentproto/app-client); with no
daemon running yet, the connection falls back to the `standaloneTools` mocks
in `ui/src/standalone-tools.ts` so the page still renders. Start the daemon
(`agentproto serve`) and the same UI code picks up real data — no branching
required, see the [`@agentproto/app-client`
README](https://github.com/agentproto/ts/tree/main/packages/app-client) for
how mode fallback works.

## 3. Build and serve the static output

```bash
agentproto app build .   # → .agentproto/ui/ (vite build, emptyOutDir)
agentproto app serve .   # standalone webapp with a real daemon bridge
```

`.agentproto/ui/index.html` ships as a placeholder page so `agentproto app
serve` and `agentproto app pack` both work immediately after scaffolding,
before you've run a build.

## 4. Make it yours

- **`.agentproto/APP.md`** — id, name, description, the declared `ui.tools`
  allowlist (extend this when a route calls a new tool).
- **`.agentproto/agents/<slug>-assistant/AGENT.md`** — replace the
  placeholder prompt/boundaries/tools with the agent's real job. See
  [Which tools can an app agent call?](./app-agent-tools.md) before adding a
  daemon tool id to `tools:` — it's an allowlist, not just a hint.
- **`.agentproto/workflows/<slug>-flow/WORKFLOW.md`** — replace the single
  placeholder step with the app's real pipeline.
- **`ui/src/router.tsx`** — add routes the same way `dashboard.tsx` /
  `about.tsx` are wired in; keep `createHashHistory()` (see below).
- **`ui/src/standalone-tools.ts`** — mock any new tool you call from a route
  so `vite dev` keeps rendering without a daemon.

### Why hash routing

The daemon, `agentproto app serve`, and the MCP-Apps panel all serve a built
app as plain static files with no server-side rewrite rules. A single
`index.html` plus `createHashHistory()` routes works from any subpath (or
even `file://`) with no per-route HTML emission — don't switch this to
browser history without also solving that serving problem.

## No `ui/`? No build step.

A hand-written, single-file vanilla UI (no `ui/` dir, or a `ui/` without a
`package.json` `scripts.build`) is a valid agentproto app too —
`agentproto app build` no-ops successfully for it. Scaffold that shape
directly with `--template vanilla` (see [Templates](#templates) above), or
start from `react-ts` and delete `ui/` in favor of a hand-written
`.agentproto/ui/index.html` later.
