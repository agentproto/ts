import { createTsupConfig } from "@agentproto/tooling/tsup/base"

const entry = {
  index: "src/index.ts",
  descriptor: "src/descriptor.ts",
  requirements: "src/requirements.ts",
}

export default createTsupConfig({
  banner: `/**
 * @agentproto/connector v0.1.0-alpha
 * ConnectorMcpDescriptor — portable description of an MCP connector.
 */`,
  entry,
  format: ["esm"],
  splitting: true,
  dts: { entry },
  // zod is the only runtime value import (the descriptor schema). Peer deps +
  // sibling agentproto packages stay external — resolved at the consumer.
  external: [
    "zod",
    "@agentproto/provider-kit",
    "@agentproto/secrets",
    "node:fs",
    "node:path",
  ],
  noExternal: [],
})
