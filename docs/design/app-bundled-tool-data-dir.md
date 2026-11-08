# Data directory of an app's bundled CLI tools

Status: contract for the change that makes `app_tool_call` honour the
registered data directory. Written before the code; the tests cite it.

## Problem

`app_tool_call` (and its twin `POST /apps/:appId/tool-call`) runs a tool that
the installed app bundles in `.agentproto/tools/*` through the app's CLI driver
(`.agentproto/drivers/*`). The subprocess gets `cwd = <app root>` and an
environment limited to the names the driver lists in
`metadata.cli.sandbox.env.pass`, read from the **daemon's own** environment.

The data directory recorded at install time (`InstalledApp.dataDir`,
`app_install { dataDir }`) never reaches that subprocess. A driver that
resolves its data with `<cwd>/data` as the last fallback therefore reads and
writes `<app root>/data`, wherever the app was installed from, whatever
`dataDir` says. Re-installing an app from a worktree makes it read the
worktree's tracked `data/`, not the real data.

## Contract

1. When the gateway runs a bundled tool of an installed app, it hands the
   driver runtime one extra environment entry:
   `AGENTPROTO_APP_DATA_DIR=<InstalledApp.dataDir>` (absolute path, as
   recorded by `app_install`).
2. The entry reaches the subprocess **only if the driver declares
   `AGENTPROTO_APP_DATA_DIR` in `metadata.cli.sandbox.env.pass`**. A driver
   that does not list it sees no change at all (opt-in, same rule as every
   other passed variable).
3. The registered `dataDir` wins over an ambient `AGENTPROTO_APP_DATA_DIR` of
   the daemon process. Any other variable (for example `JOBKIT_DATA_DIR`) keeps
   today's behaviour: passed from the daemon environment when listed, and an
   app that ranks it above `AGENTPROTO_APP_DATA_DIR` keeps that precedence.
4. Nothing else is added: no secret, no path other than `dataDir`, no
   environment for drivers of other kinds (http, mcp, browser).
5. When the installed app has no `dataDir` (record without one), nothing is
   injected: behaviour identical to today.
6. The mechanism is a typed, non-secret channel (`hostEnv`) distinct from
   `secrets`: it is never used to resolve `${secrets.*}` argv templates and is
   never logged as a secret.
7. Scope: the gateway (`app_tool_call`, `POST /apps/:appId/tool-call`). The
   workflow runner path is unchanged.

## Out of scope and guard rails

- Approval tools (`approval_*`) are not added to anything: this change does not
  touch any `ui.tools` list, allowlist, or `APP_UI_DISCOVERY_TOOLS`.
  Allowlist enforcement, link-scope and the `app_link_mint` refusal run before
  dispatch and are untouched.
- The data directory is not validated or created here (`app_install` already
  does).
- Apps keep owning the meaning of the directory; this only delivers it.

## Test obligations

- Driver runtime: a declared `pass` name is filled from `hostEnv`, overriding
  the process environment; an undeclared name is not delivered; `hostEnv` is
  not available to argv `${secrets.*}` templates.
- Gateway: an installed app whose driver echoes `AGENTPROTO_APP_DATA_DIR` gets
  the registered `dataDir` through `performAppToolCall`; a driver that does not
  declare it gets nothing; an app without `dataDir` gets nothing. Both gateway
  tests fail on the code before the change.
