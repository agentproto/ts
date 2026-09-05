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
  `templates/workstation/versions.json`: `@agentproto/cli@0.17.0`, `@agentproto/adapter-hermes@0.4.10`, `@agentproto/adapter-opencode@1.1.10`, `opencode-ai@1.18.28`. The on-boot
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
