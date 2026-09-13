# @agentproto/sandbox-box

ascii.dev Box `SandboxProvider` for `@agentproto/sandbox`. Boots a Box cloud
computer, installs an always-on `systemd` unit for the agentproto daemon, and
exposes its MCP endpoint as a URL — so `createSandboxAgentSessionHost` can
hand it straight to `connectDaemonAgentSessionHost` (`@agentproto/worktree`)
and run any `AgentStep` inside the sandbox, unchanged.

## Usage

```ts
import { createSandboxAgentSessionHost } from "@agentproto/sandbox"
import { boxSandboxProvider } from "@agentproto/sandbox-box"
import { runWorkflow } from "@agentproto/workflow-runtime"
import { worktreeAgentWorkflow } from "@agentproto/worktree"

const host = await createSandboxAgentSessionHost({
  provider: boxSandboxProvider,
  spec: { provider: "box", config: {} },
  secrets: { slugs: ["OPENROUTER_API_KEY"] },
})
try {
  await runWorkflow({ workflow: worktreeAgentWorkflow, input, agents: host })
} finally {
  await host.stop()
}
```

Requires `BOX_API_KEY` in the host process's environment.

## Notes

- Box's `host <port>` CLI exposes a port at
  `https://<box-subdomain>-<port>.on.ascii.dev`; re-running it for the same
  box+port returns the same URL, so this provider computes the hostname
  directly from `Box.subdomain` (assigned once, persists across
  stop/resume/fork) rather than parsing command output.
- Box's command API (`POST /boxes/{id}/commands`) is synchronous-only — no
  `background` flag like e2b's. A bare `&`-backgrounded process would die
  with the command's process group, so the daemon is installed as a
  `systemd` unit (`Restart=always`) instead: `systemctl enable --now` hands
  it to PID 1, which survives `box stop` (filesystem snapshot) + `box
  resume` — cleaner than e2b, which has to re-issue its serve command after
  every resume.
- systemd services don't inherit the invoking shell's environment, so
  secrets resolved into the sandbox env (e.g. `OPENROUTER_API_KEY`) are
  written to an `EnvironmentFile` (`/etc/agentproto/agentproto.env`, 0600)
  the unit references.
- Box's own default TTL is 3600s (1 hour) auto-stop. This provider disables
  it by default (`ttlSeconds: null`, same lesson as e2b's
  `DEFAULT_SANDBOX_TIMEOUT_MS`) — set `config.ttlSeconds` to override.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
