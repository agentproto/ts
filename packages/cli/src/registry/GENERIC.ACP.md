---
protocol: acp
transport: stdio
---

# Generic ACP agent

Shared ACP contract for every **generic** agent CLI — those minted from a
plain [`AcpAgentSpec`](./acp-generic.ts) (the curated `ACP_CATALOG` or a
user's `~/.agentproto/config.json` `acpAgents` entry) rather than shipped as
a bespoke `@agentproto/adapter-*` package.

Any CLI that already speaks the [Agent Client Protocol](https://agentclientprotocol.com)
over stdio JSON-RPC is drivable with zero adapter code: agentproto spawns
`bin bin_args`, performs the ACP `initialize` / `session/new` handshake via
the shared `createAcpProtocolArm`, and streams turns. This file is the AIP-45
`acp` ref that every generic handle points at — the wire behaviour is the
standard ACP contract, so there is nothing agent-specific to document here.

- **Spawn** — `bin` + `bin_args` from the spec (e.g. `gemini --experimental-acp`).
- **Working directory** — passed to the agent over the ACP `session/new`
  `cwd` field. A spec's optional `cwd_flag` also forwards it on argv for CLIs
  that additionally want it as a flag.
- **Resume** — advertised only when the spec sets `resumable: true`; maps to
  `capabilities.resumable` + `continuation.default: native-resume`.
- **Models** — whatever the underlying CLI accepts; a spec's `models.allowed`
  is an informational hint, not an enforced allow-list.

For agents that need bespoke env scrubbing, gateway modes, permission
handling, or a non-stdio transport, write a real adapter package instead.
