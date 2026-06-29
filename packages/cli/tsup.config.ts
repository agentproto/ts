import { readFileSync } from "node:fs"
import { createTsupConfig } from "@agentproto/tooling/tsup/base"

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
)

export default createTsupConfig({
  define: { __CLI_VERSION__: JSON.stringify(version) },
  banner: `/**
 * @agentproto/cli v${version}
 * The \`agentproto\` binary — install / run / serve AIP-45 agent CLIs.
 */`,
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    "registry/runtime": "src/registry/runtime.ts",
    "registry/builtins": "src/registry/builtins.ts",
    "registry/plugins": "src/registry/plugins.ts",
    "registry/manifest": "src/registry/manifest.ts",
    "util/credentials": "src/util/credentials.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: {
    entry: {
      index: "src/index.ts",
      "registry/runtime": "src/registry/runtime.ts",
      "registry/builtins": "src/registry/builtins.ts",
      "registry/plugins": "src/registry/plugins.ts",
      "registry/manifest": "src/registry/manifest.ts",
      "util/credentials": "src/util/credentials.ts",
    },
  },
  external: [
    "@agentproto/acp",
    "@agentproto/driver",
    "@agentproto/driver-agent-cli",
    // Third-party deps — externalised so the published cli installs
    // them via npm at runtime. `gray-matter` is CJS + does dynamic
    // require("fs"), which esbuild can't safely inline into an ESM
    // bundle, so it MUST stay external. Same for the MCP SDK, which
    // transitively pulls in `cross-spawn` (CJS + dynamic require) —
    // bundling it produces an ESM file that crashes on first import.
    "@agentproto/runtime-profile-standard",
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/sdk/*",
    "gray-matter",
    "ink",
    "react",
    "ink-text-input",
    "ink-spinner",
    "marked",
    "marked-terminal",
    "cli-highlight",
    "zod",
    "ws",
    "node:child_process",
    "node:fs",
    "node:fs/promises",
    "node:os",
    "node:path",
    "node:process",
    "node:url",
    "node:util",
    // node-pty is an optional dep with a native binary (.node). Bundling
    // it breaks the relative-path native-binding resolution at runtime.
    "node-pty",
  ],
  // Workspace @agentproto/* packages NOT yet on npm — bundle them
  // into cli.mjs. Once each lands on npm independently, move it to
  // `external` and declare it under `dependencies` in package.json.
  noExternal: [
    "@agentproto/agent-runtime",
    "@agentproto/agent-runtime/adapters/substrate-file",
    "@agentproto/agent-runtime/adapters/dispatcher-mention",
    "@agentproto/agent-runtime/adapters/state-fs",
    "@agentproto/agent-runtime/adapters/participant-agent-cli",
    "@agentproto/agent-runtime/adapters/telemetry",
    "@agentproto/runtime",
    "@agentproto/model-catalog",
    "@agentproto/model-catalog/llm",
    "@agentproto/agent",
    "@agentproto/manifest",
    "@agentproto/mcp-server",
    "@agentproto/extension",
    "@agentproto/define-doctype",
  ],
})
