# @agentproto/driver-cli

Reference implementation of the CLI provider specialisation over
[**AIP-30 DRIVER.md**](https://agentproto.sh/docs/aip-30) `defineDriver` —
`defineCliDriver` wraps a binary as a conformant provider: argv templating
against `${input.X}` / `${secrets.X}`, subprocess spawn, exit-code → semantic
error mapping, and text/JSON output parsing.

```ts
import { defineCliDriver } from "@agentproto/driver-cli"

const ghCli = defineCliDriver({
  id: "gh-cli",
  name: "GitHub CLI",
  description: "Wraps gh for PR operations.",
  kind: "cli",
  bin: "gh",
  implements: [
    {
      tool: "./tools/create-pr/TOOL.md",
      version: "^1",
      metadata: { cli: { argv: ["pr", "create", "--title", "${input.title}"] } },
    },
  ],
})
```

## Working directory

`CliDriverDefinition.cwd` (optional, absolute) sets the spawned subprocess's
working directory. Left unset, the subprocess inherits whatever directory the
*host* process happens to be running in — correct for a standalone
TS-authored driver invoked directly, but not what an app-bundled DRIVER.md
usually means.

**Relative paths in an app-bundled cli driver resolve against the app
root**, not the daemon's own cwd. When this driver is loaded from an app
bundle via `@agentproto/app-kit`'s `loadAppBundledTools`, `cwd` is set to the
app root (the directory containing `.agentproto/`) automatically, unless the
DRIVER.md's `metadata.cli.cwd` overrides it — itself resolved relative to the
app root, and rejected at load time if it would resolve outside the app
root.

## Spec

See [AIP-29](https://agentproto.sh/docs/aip-29) for the CLI provider
specialisation and [AIP-30](https://agentproto.sh/docs/aip-30) for the base
`defineDriver` contract. This package is the TypeScript reference
implementation.
