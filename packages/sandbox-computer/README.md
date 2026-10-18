# @agentproto/sandbox-computer

`SandboxProvider` for [`@agentproto/sandbox`](../sandbox) backed by a
**self-hosted microVM "computer" fleet's controller** — the same plumbing
shape as [`@agentproto/sandbox-e2b`](../sandbox-e2b) (boot the agentproto
daemon inside the box, expose its `/mcp` endpoint, pause/resume/reattach),
against a controller API instead of a vendor SDK.

## What it does

| `SandboxProvider` seam | Controller API |
| --- | --- |
| `boot(spec)` | `POST /v1/computers` → poll `GET /v1/computers/:id` until `running` → ensure the daemon is healthy in-box (install `@agentproto/cli` if needed, `nohup agentproto serve … &`) |
| `exec(opts)` | `POST /v1/computers/:id/exec` (argv-based; the adapter wraps commands as `/bin/bash -lc`) |
| `readFile` / `writeFile` | chunked base64 through the exec seam |
| `expose(port)`, `mcpUrl` | URL template (see `config.gatewayUrl`) |
| `pause()` | `POST /v1/computers/:id/suspend` (full snapshot + stop) |
| resume (inside `connect`) | `POST /v1/computers/:id/resume` — the controller may restore into a **new** computer id; the provider adopts it transparently and keeps the old id resolvable for `probe()` within the process |
| `stop()` | `DELETE /v1/computers/:id` (rm + snapshot cleanup) |
| `probe(id)` | `GET /v1/computers/:id` (404 ⇒ `{alive:false}`) |
| `connect(sandboxId)` | GET → resume when suspended → ensure daemon → reattach |

## Config

Via `agent_start({ sandbox: { provider: "computer", config: … } })` or the
provider's `setup` (stored creds), plus env fallbacks:

| config | env fallback | default | notes |
| --- | --- | --- | --- |
| `controllerUrl` | `COMPUTER_CONTROLLER_URL` | — | Controller base URL, e.g. `http://host:7110`. |
| `token` (secret) | `COMPUTER_CONTROLLER_TOKEN` | — | Controller bearer service token. Resolved from a credential ref by the runtime (`setup_sandbox_provider` → stored creds → env), **never** logged or written anywhere else. |
<<<<<<< HEAD
| `tenantId` | `COMPUTER_TENANT_ID` | `agentproto` | Sent as `X-Tenant-Id` on every request; computers are created under it. A stored `setup_sandbox_provider` value fills the env var when unset. |
| `egress` | — | none | Allowlist forwarded as the create body's `egress.allow`: entries `"host"`, `"host:port"` (port defaults to 443) or `{host, port?}`. The reference controller denies ALL egress, DNS included, when this is absent, so the on-boot `npm i -g @agentproto/cli` needs at least `registry.npmjs.org`. |
=======
| `tenantId` | `COMPUTER_TENANT_ID` | `agentproto` | Sent as `X-Tenant-Id` on every request; computers are created under it. |
>>>>>>> 9b836b423a63a48c052a83ef619f9726ea3a2473
| `template` | — | `agentproto-workstation` | Controller template id. The reference controller's stock registry currently only ships `base`/`node`/`browser` — point this at whatever template id your controller advertises (or ask the controller admin to register a workstation template). |
| `cpus`, `memoryMiB`, `rootDiskMiB` | — | — | Resource limits forwarded to create. |
| `ttlSeconds` | — | — | Computer TTL sent as create `ttl`. |
| `maxSessions` | — | `1` | How many sessions THIS process may map onto one computer. |
| `port` | — | `18790` | Daemon port inside the computer. |
| `workspace` | — | `/home/user` | `agentproto serve --workspace`. |
| `gatewayUrl` | — | `http://<computer-name>:<port>` | URL template with `{port}`/`{id}` placeholders for reaching a computer's ports. Default assumes the box network is addressable by the computer's generated name; set it when computers sit behind an edge proxy. |
| `updateCliOnBoot`, `cliVersion`, `installPackages`, `setupCommands` | — | install on | Same semantics as sandbox-e2b's boot flow. |
| `waitReadyTimeoutMs`, `daemonReadyTimeoutMs` | — | 120s / 30s | Boot readiness windows. |

## Capabilities

Registered under the slug `computer`:

```json
{
  "networkEgress": true,
  "mounts": false,
  "lifecyclePause": true,
  "readOnly": false,
  "exec": true,
  "sharedSessions": true
}
```

`sharedSessions: true` is descriptive metadata: this provider's box is
advertised as shareable — one computer's daemon could hang off several
agentproto sessions multiplexing over `mcpUrl`. No runtime behaviour reads
this flag yet. `config.maxSessions` separately caps how many sessions a
single host process books onto one computer; the controller has no
cross-process attach/detach refcount (see gaps below), so the cap is
enforced per process only.

## Secrets

- The controller token travels only in the `Authorization: Bearer …` header.
- A fresh `--auth-token` (UUID) gates the daemon inside each computer; it
<<<<<<< HEAD
  exists only inside the box (`~/.agentproto-daemon.log`'s command
=======
  exists only inside the box (`/var/log/agentproto-daemon.log`'s command
>>>>>>> 9b836b423a63a48c052a83ef619f9726ea3a2473
  line is the one place it is used) and is deliberately never surfaced on
  `BootedSandbox`.
- This package logs nothing and redacts the service token from every error
  message it produces (`[redacted]`).

## Pointing it at a controller

```ts
const booted = await computerSandboxProvider.boot(
  {
    provider: "computer",
    config: {
      controllerUrl: "https://host:7110",
      tenantId: "team-x",
      template: "node", // whatever the controller's registry advertises
      cpus: 4,
      memoryMiB: 8192,
      gatewayUrl: "https://edge.internal:{port}/computers/{id}",
      maxSessions: 4,
    },
  },
  { env: { /* secrets to deliver into the guest */ } },
)
// booted.mcpUrl — feed it to connectDaemonAgentSessionHost as usual.
```

## Known gaps (adapter needs, controller lacks)

- **No attach/detach refcount**: the controller is session-agnostic, so
  `maxSessions` cannot be authoritative across host processes, and an
  abandoned attach cannot be detected by the controller.
- **`resume` renames the computer**: a suspend→restore cycle rebuilds the
  box under a new generated id. The provider aliases old→new in-process; the
  session ledger may still record the pre-suspend id, so an `attach` after a
  cross-process restore requires the NEW id.
- **No generic port-publish API**: only the browser template's CDP relay
  gets a host-side published port. `mcpUrl` therefore defaults to the
  computer's own name (`http://<name>:<port>`) or a `gatewayUrl` template —
  neither is brokered by the controller.
- **No extend-timeout endpoint**: the TTL is fixed at create; `extendTimeout`
  is a documented no-op rather than a real re-arm.
- **Detached daemon start is unverified against real hardware**: the API's
  exec endpoint is synchronous; the provider backgrounds `agentproto serve`
  with `nohup … &` inside one `bash -lc`. The preferred production path is a
  template that autostarts the daemon (the adapter probes health first and
  skips its own start when the daemon is already up).
- **Template registry**: the reference controller registers only
  `base`/`node`/`browser`; the adapter's default template id is
  `agentproto-workstation` and must be registered controller-side, or
  `config.template` pointed at an existing one.
