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

## Notes

- The daemon's own origin allowlist defaults to `localhost:*`; this provider
  opens it for the sandbox's own public host (`--allow-origin
  https://<getHost>`) so the host process can reach it over
  `https://<getHost>/mcp`.
- The pre-built `agentproto-workstation` template can lag behind the latest
  `@agentproto/cli` release. This provider runs `npm i -g
  @agentproto/cli@latest` before starting the daemon (set `updateCliOnBoot:
  false` in `spec.config` to skip it — e.g. once the template is rebuilt
  against a current release, which is the cleaner long-term fix).

## License

MIT — see [LICENSE](./LICENSE).
