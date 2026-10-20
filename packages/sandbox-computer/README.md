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
| `tenantId` | `COMPUTER_TENANT_ID` | `agentproto` | Sent as `X-Tenant-Id` on every request; computers are created under it. A stored `setup_sandbox_provider` value fills the env var when unset. |
| `egress` | — | none | Allowlist forwarded as the create body's `egress.allow`: entries `"host"`, `"host:port"` (port defaults to 443) or `{host, port?}`. The reference controller denies ALL egress, DNS included, when this is absent, so the on-boot `npm i -g @agentproto/cli` needs at least `registry.npmjs.org`. |
| `egressIp` | — | `"shared"` | Egress IP selection forwarded as create `egressIp` (AIP-36 v1.3): `"shared"` (default, omitted from the create body so older controllers keep working), `"auto"`, `"dedicated"`, or a 1-8 character lowercase alphanumeric pool slot id. Also accepted from the spec-level `network.egressIp`; precedence: `config.egressIp` wins when set, otherwise `network.egressIp` applies, and `"shared"` is the default. A spec-level `network.egressIp` of `"shared"` counts as unset, so a conflict is only rejected before any controller call when both sides set different non-`"shared"` values. The booted handle reports the controller's `egressIp: {id, publicIp} | null` on boot and connect. |
| `template` | — | `agentproto-workstation` | Controller template id. The reference controller's stock registry currently only ships `base`/`node`/`browser` — point this at whatever template id your controller advertises (or ask the controller admin to register a workstation template). |
| `cpus`, `memoryMiB`, `rootDiskMiB` | — | — | Resource limits forwarded to create. |
| `ttlSeconds` | — | — | Computer TTL sent as create `ttl`. |
| `maxSessions` | — | `1` | How many sessions THIS process may map onto one computer. |
| `sessionHolder` | `AGENTPROTO_SESSION_ID` | none | Stable holder identity sent as the optional `holder` body on attach/detach and, in `daemonRoute` mode, as the `X-Computer-Session-Holder` header on every relayed request (HTTP and WebSocket). A controller that tracks holders then treats a re-attach by the same holder as idempotent (a restarted daemon re-attaches onto the slot its dead predecessor still held instead of hitting the 409 session limit) and scopes the detach to that holder's slot. The env fallback covers a provider running inside a spawned agent session; absent means the body-less legacy attach. An explicit `gatewayUrl` that goes through the controller can carry the header via `extraHeaders` instead. |
| `port` | — | `18790` | Daemon port inside the computer. |
| `workspace` | — | `/home/user` | `agentproto serve --workspace`. |
| `gatewayUrl` | `COMPUTER_GATEWAY_URL` | `http://<computer-name>:<port>` | URL template with `{port}`/`{id}`/`{hostPort}` placeholders for reaching a computer's ports (`{hostPort}` is the host port the controller published for the daemon port; the boot fails if none). Default assumes the box network is addressable by the computer's generated name; set it when computers sit behind an edge proxy. The daemon is started with `--allow-origin` for this URL's origin, recorded in `~/.agentproto-daemon.origin`; on reconnect a healthy daemon whose recorded origin differs (the host port changed) is restarted. A daemon without that file (autostarted by the template) is left as is. The runtime exposes it as an optional setup field (stored provider creds fill `COMPUTER_GATEWAY_URL` when unset), which a daemon-restart re-attach needs because it carries no per-spawn config. It is not required in `daemonRoute` mode; supplying both is rejected as a conflicting configuration. When the controller's GET omits `ports`, a reconnect recovers the host port from the origin marker. `mcpUrl` is the resolved URL plus `/mcp`. |
| `daemonRoute` | `COMPUTER_DAEMON_ROUTE` (`1`) | off | Reach each computer's daemon through the controller at `<controllerUrl>/v1/computers/{id}/daemon` instead of a per-port `gatewayUrl`, which is not required in this mode and must be omitted (supplying both is rejected with a clear error). The daemon call then carries the controller credential in `X-Controller-Authorization: Bearer …` and the tenant in `X-Tenant-Id`, next to the daemon's own `Authorization`, via `BootedSandbox.authHeaders`. Needs a controller that serves that route. |
| `extraHeaders` | `COMPUTER_EXTRA_HEADERS` (JSON object), `COMPUTER_ACCESS_CLIENT_ID` + `COMPUTER_ACCESS_CLIENT_SECRET` | none | Headers added to every controller call (and to daemon calls in `daemonRoute` mode), for a proxy in front of the controller that wants its own credentials. The id/secret pair maps to `CF-Access-Client-Id` / `CF-Access-Client-Secret`. Values are secrets: never logged, redacted from errors. `Authorization`, `X-Tenant-Id` and `Content-Type` are owned by the client and ignored here. Prefer the env vars (or the stored provider profile) over `config`, which can end up in session metadata. |
| `updateCliOnBoot`, `cliVersion`, `installPackages`, `setupCommands` | — | install on | Same semantics as sandbox-e2b's boot flow. |
| `waitReadyTimeoutMs`, `daemonReadyTimeoutMs` | — | 120s / 30s | Boot readiness windows. |

The provider validates the controller's `egressIp` field with the typed `@agentproto/computer-api` contract, so a malformed `egressIp` in a controller response fails the call instead of being ignored.

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
this flag yet. `config.maxSessions` is forwarded at create (the controller
sizes the computer's CPU and RAM for it) and counted by the controller: boot
and connect attach a session, pause and stop detach it, and a connect past the
cap is refused — except a re-connect by the same `sessionHolder`, which is
idempotent and keeps its slot. The last session to stop removes the computer.
A controller without the attach routes falls back to a per-process count.

## Capacity and egress errors

The controller's machine error codes are mapped to typed errors with a stable
`code` (the `ComputerSandboxError` exported by this package):

| controller response | provider error `code` |
| --- | --- |
| `400 {error:"egress-pool-disabled"}` (no pool configured) | `sandbox_egress_pool_unavailable` |
| `400 {error:"egress-pool-unknown"}` (unknown pool/slot) | `sandbox_egress_slot_unknown` |
| `409 {error:"egress-pool-exhausted"}` (pool full) | `sandbox_egress_pool_exhausted` |
| `409 {error:"egress-slot-dedicated"}` (slot already dedicated) | `sandbox_egress_slot_dedicated` |
| `503 {error:"host-capacity", resource, requested, available}` | `sandbox_capacity` |

A `503 host-capacity` response also carries the controller's `Retry-After`
as `retryAfterMs`, alongside `resource`, `requested` and `available` on the
error, so a caller can wait and retry (or fall back to another host) without
parsing strings. Error messages only quote the status/code and capacity
numbers; secrets never appear in them.

## Secrets

- The controller token travels only in the `Authorization: Bearer …` header.
- A fresh `--auth-token` (UUID) gates the daemon inside each computer (the
  published port reaches it as a non-loopback peer, so the daemon requires
  it). It is written `0600` to `~/.agentproto-daemon.token` in the box and
  returned on `BootedSandbox.token`/`authHeaders` for the host's
  authenticated reads. It appears nowhere else (no logs, no errors);
  a reconnect reads it back from that file. A daemon autostarted by the
  template has no token file and gets no auth headers.
- Extra headers (for example an edge service token) are sent as given,
  and redacted from every error message like the service token.
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

- **No attach expiry**: an attach whose process died is not detected by the
  controller; an operator clears it with a forced delete.
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
