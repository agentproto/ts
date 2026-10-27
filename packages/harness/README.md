# @agentproto/harness

Implements the AIP-45 HARNESS. It loads an `AGENT-CLI.md` manifest, spawns the
binary, and dispatches turns through an ACP, MCP, or proprietary protocol arm.

Spec: [AIP-45](https://agentproto.sh/docs/aip-45)

## Install

```sh
pnpm add @agentproto/harness
```

## Usage

```ts
import { defineHarness } from "@agentproto/harness"

export const myHarness = defineHarness({
  id: "my-agent",
  description: "A minimal AIP-45 harness.",
})
```

`defineAgentCli` is the old alias and still works. `SPEC_NAME` is
`harness/v1`, the AIP-70 registry name for this package.

`@agentproto/driver-agent-cli` is the deprecated old name; it remains a thin
re-export shim for existing installs.
