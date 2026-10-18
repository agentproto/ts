# @agentproto/sandbox-instabox

InstaBox `SandboxProvider` for `@agentproto/sandbox` (https://instabox.sh, API
https://api.instabox.sh). Boots an InstaBox VM (`universal` template by
default: Debian 13, git, gh, Node 22, Python, Go, Rust, Docker, Claude Code,
Codex), installs an always-on `systemd` unit for the agentproto daemon
(`Restart=always`, brokered secrets in a root-owned 0600 `EnvironmentFile`),
publishes the daemon port through the account's public edge, and exposes its
MCP endpoint as a URL, so `createSandboxAgentSessionHost` can hand it straight
to `connectDaemonAgentSessionHost` (`@agentproto/worktree`) and run any
`AgentStep` inside the sandbox, unchanged.

## Usage

```ts
import { createSandboxAgentSessionHost } from "@agentproto/sandbox"
import { instaboxSandboxProvider } from "@agentproto/sandbox-instabox"
import { runWorkflow } from "@agentproto/workflow-runtime"
import { worktreeAgentWorkflow } from "@agentproto/worktree"

const host = await createSandboxAgentSessionHost({
  provider: instaboxSandboxProvider,
  spec: { provider: "instabox", config: {} },
  secrets: { slugs: ["OPENROUTER_API_KEY"] },
})
try {
  await runWorkflow({ workflow: worktreeAgentWorkflow, input, agents: host })
} finally {
  await host.stop()
}
```

Requires `INSTABOX_API_KEY` in the host process's environment (or
`spec.config.apiKey`; both are read from there, e.g.
`{ provider: "instabox", apiKey: "ibk_..." }` via `setup_sandbox_provider`).

## Notes

- The public port edge (a published port at
  `https://{port}-{machineIdWithoutM_}.instabox.tech`) is UNLOCKED at
  InstaBox: the daemon's own bearer token is the only gate on `/mcp`, so the
  unit is started with `--auth-token` whose value is substituted by systemd
  from the 0600 EnvironmentFile (`AGENTPROTO_AUTH_TOKEN`), so the token never
  rides an exec argv. `booted.token` / `.authHeaders` carry it for callers.
- InstaBox has NO file-upload route: `writeFile` and `readFile` stream base64
  through `exec` (chunks of at most 700 KB, so each stdin/stdout stays under
  the API's 1 MiB cap), with `mkdir -p` creating parents.
- A background `cmd &` without redirected stdio keeps the synchronous exec
  open until its timeout: the provider never backgrounds anything. The daemon
  runs as a systemd unit (`Restart=always`), which survived `kill -9`,
  suspend/resume and auto-suspend in the measured wiring.
- A MANUALLY suspended machine does not wake on its own (public URL 503, exec
  and `wake` answer 409), so this provider NEVER sends the suspend verb and
  does NOT implement `pause()`: callers fall back to `stop()`, which deletes
  the machine. The provider requests `autoSuspendAfterSeconds: 0`
  (configurable via `config.autoSuspendAfterSeconds`), but the live API ignores
  0 and keeps its 1800s window; an auto-suspended box wakes on a public
  request, `wake` or `exec`, and `connect` revives a manually suspended one.
- Account limit: 5 machines, suspended and stopped ones counting. `boot`
  pre-checks `GET /v1/usage` + `GET /v1/machines` and throws a typed
  `SandboxQuotaError` (fall back to another provider) when the cap is hit.
- `connect(sandboxId)` is state aware: `running` is a no-op; an auto-suspended
  machine gets `wake`; a manually suspended one falls back to `resume`; a
  stopped one `start`. The daemon bearer is re-derived from the env file, the
  lifetime is re-armed (PATCH `timeoutSeconds` restarts the countdown from
  now), and health is re-verified through the public edge.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
