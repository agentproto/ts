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
  name: "my-agent",
  id: "my-agent",
  description: "A minimal AIP-45 harness.",
  version: "1.0.0",
  bin: "my-agent",
  install: [{ method: "npm", package: "my-agent-cli", global: true }],
  version_check: {
    cmd: "my-agent --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=1.0.0",
  },
  sandbox: "workspace",
  protocol: "acp",
  acp: "./ACP.md",
})
```

`SPEC_NAME` is `harness/v1`, the AIP-70 registry name for this package.
