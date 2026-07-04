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

## License

MIT — see [LICENSE](./LICENSE).
