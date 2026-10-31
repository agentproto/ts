# @agentproto/sandbox-e2b

e2b `SandboxProvider` for `@agentproto/sandbox`. Boots the pre-built
`agentproto-workstation` e2b template, starts the agentproto daemon inside
it, and exposes its MCP endpoint as a URL — so
`createSandboxAgentSessionHost` can hand it straight to
`connectDaemonAgentSessionHost` (`@agentproto/worktree`) and run any
`AgentStep` inside the sandbox, unchanged.

## Usage

```ts
import { createSandboxAgentSessionHost } from "@agentproto/sandbox"
import { e2bSandboxProvider } from "@agentproto/sandbox-e2b"
import { runWorkflow } from "@agentproto/workflow-runtime"
import { worktreeAgentWorkflow } from "@agentproto/worktree"

const host = await createSandboxAgentSessionHost({
  provider: e2bSandboxProvider,
  spec: { provider: "e2b", config: {} },
  secrets: { slugs: ["OPENROUTER_API_KEY"] },
})
try {
  await runWorkflow({ workflow: worktreeAgentWorkflow, input, agents: host })
} finally {
  await host.stop()
}
```

Requires `E2B_API_KEY` in the host process's environment.

## Sizes

Pick the box size per spawn with `config.size`. Each size is its own published
template (`agentproto-workstation-<size>`, declared in
`templates/workstation/versions.json`):

```ts
agent_start({ sandbox: { provider: "e2b", config: { size: "large" } } })
```

<!-- sync-templates:sizes:start -->
| size | vCPU | RAM (MB) | e2b alias | status |
|---|---|---|---|---|
| `nano` | 1 | 1024 | `agentproto-workstation-nano` | published |
| `small` | 2 | 2048 | `agentproto-workstation-small` | published |
| `medium` | 2 | 4096 | `agentproto-workstation-medium` | published |
| `large` (default) | 4 | 8192 | `agentproto-workstation-large` | published |
| `x-large` | 8 | 16384 | `agentproto-workstation-x-large` | **unavailable** — e2b refused: `400: Memory can't be higher than 8192 MiB (if you need to increase this limit, please contact support)` |
| `xx-large` | 16 | 32768 | `agentproto-workstation-xx-large` | **unavailable** — e2b refused: `400: CPU count can't be higher than 8 (if you need to increase this limit, please contact support)` |

The bare `agentproto-workstation` alias (and `agentproto-workstation-dev`) is built at
the default size, `large` (4 vCPU / 8192 MB).
<!-- sync-templates:sizes:end -->

- **A full `pnpm build` + `pnpm test` of agentproto/ts needs `large` or
  bigger.** Smaller boxes OOM-kill the session mid-build and the work is lost
  with the box.
- No `size` and no `template` boots the bare `agentproto-workstation` template,
  which is built at the default size. An explicit `config.template` always wins
  over `config.size`.
- An unknown size fails the boot with the list of valid ones. A size marked
  unavailable fails with the exact error e2b returned when its template was
  refused (today: the plan caps a sandbox at 8 vCPU / 8192 MB), rather than
  booting a smaller box.
- e2b has no GPU sandboxes, so there is no GPU size.

## Build environment

Next to the 4 GiB swap file it enables on a fresh boot, the provider sizes
Node builds to the box: pnpm runs one package build per vCPU by default and
each tsup DTS worker takes Node's default heap, so a plain `pnpm build` dies
with `JavaScript heap out of memory` long before the RAM is gone. On every
boot it derives a budget from the resolved size preset —
`concurrency = max(1, min(cpu, floor(ram MB / 3072)))` and
`heap = clamp(floor(ram MB * 0.6 / concurrency), 768, 4096)` (the default
4 vCPU / 8192 MB box → 2 builds at a 2457 MB heap) — and ships it as
`NODE_OPTIONS=--max-old-space-size=…`, `npm_config_workspace_concurrency`
and `TURBO_CONCURRENCY` two ways: in the daemon's start env, so the daemon
and every adapter it spawns inherit them, and in
`/etc/profile.d/agentproto-build.sh`, so every login-shell command in the box
(the agent's bash tool, any `exec`) sources them too. An explicit
`config.template` has no recorded size, so the box is probed once at boot
(`nproc`, `free -m`). A caller's own value always wins: a passed
`NODE_OPTIONS` with `--max-old-space-size` is kept untouched, one without
gets the box heap appended. Override the numbers with
`config.buildEnv: { concurrency, heapMb }`, or disable the whole thing with
`config.buildEnv: false`.

## Pushing and opening PRs from the box

The workstation template bakes the GitHub CLI (`gh`, pinned in
`templates/workstation/versions.json` → `tools.gh`). When the spawn's
workspace has a registered remote (`agentproto workspace remote set <slug>
--url <https-url> --token-stdin`), the daemon injects that token into the box
twice: as `AGENTPROTO_GIT_TOKEN`, read by the git credential helper, and as
`GH_TOKEN`, read by `gh`. So the agent can `git push` and
`gh pr create` itself, provided the token has **Contents: write** and **Pull
requests: write** on the repository (a fine-grained PAT scoped to that one
repo is the right shape).

Both names are reserved. They are only ever derived by the daemon from the
workspace's own keychain ref, and they are stripped from any caller-declared
`env.passthrough`, `env.auth.state.env` or `join.tokenEnv`. So a caller can
neither shadow the token nor pull the daemon's own `GH_TOKEN` into a box.
The token never appears in a command, URL or argv. It is still an ordinary env
var inside the box, so the agent can read it: scope it to the one repository
and revoke it when the work is done.

## Port exposure

Each booted sandbox exposes an `expose(port)` method that returns the public
URL for any port the sandboxed process listens on:

```ts
const host = await createSandboxAgentSessionHost({ provider: e2bSandboxProvider, spec, secrets })
// After booting, expose any app port the sandboxed process is listening on:
const { url } = await host.expose!(3210)
// url → "https://3210-<sandboxId>.e2b.app"
```

To pre-expose ports at boot time, declare `extraPorts` in the spec. The
returned `BootedSandbox.ports` map (and the session descriptor's `sandboxPorts`
field) are populated immediately so orchestrators can read the URL without a
separate `expose()` call:

```ts
const host = await createSandboxAgentSessionHost({
  provider: e2bSandboxProvider,
  spec: { provider: "e2b", config: {}, extraPorts: [3210] },
  secrets: { slugs: ["E2B_API_KEY"] },
})
console.log(host.ports) // { 3210: "https://3210-<sandboxId>.e2b.app" }
```

Loopback bind is enough inside the VM — e2b's edge handles forwarding. See
`SandboxPortExposureUnsupportedError` in `@agentproto/sandbox` for the error
thrown when calling `exposePort()` on a provider that does not support exposure.

## Notes

- The daemon's own origin allowlist defaults to `localhost:*`; this provider
  opens it for the sandbox's own public host (`--allow-origin
  https://<getHost>`) so the host process can reach it over
  `https://<getHost>/mcp`.
<!-- sync-templates:start -->
- The default `agentproto-workstation` template is declared in
  `templates/workstation/versions.json`: `@agentproto/cli@1.31.0`, `@agentproto/adapter-hermes@0.4.38`, `@agentproto/adapter-mastra-agent@0.7.33`, `@agentproto/adapter-opencode@1.8.2`, `opencode-ai@1.19.0`, `gh@2.102.0`. The on-boot
  `npm i -g` is skipped by default only once the template's recorded `baked`
  block PROVES the image already carries the requested pin; until then the
  legacy boot install stays on.
<!-- sync-templates:end -->
- Custom (non-baked) templates can lag behind: the provider runs `npm i -g
  @agentproto/cli@<cliVersion>` before starting the daemon on them (`cliVersion`
  defaults to `@latest`; pin it in `spec.config` for reproducible boots). Set
  `updateCliOnBoot: false` in `spec.config` to skip the install entirely.

## License

MIT — see [LICENSE](./LICENSE).
