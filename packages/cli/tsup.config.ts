import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createTsupConfig } from "@agentproto/tooling/tsup/base"

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
)

// Stub for ink's dev-only react-devtools-core static import (see the stub file
// for the full rationale). Bundling the Ink stack means this import lands in
// the binary; aliasing it to a no-op keeps it resolvable without shipping the
// dev dependency.
const reactDevtoolsStub = fileURLToPath(
  new URL("./src/stubs/react-devtools-core.ts", import.meta.url)
)

export default createTsupConfig({
  define: { __CLI_VERSION__: JSON.stringify(version) },
  // The base config sets esbuildOptions too; this override replaces it, so
  // re-apply `sourcesContent` here alongside the devtools alias.
  esbuildOptions(options) {
    options.sourcesContent = true
    options.alias = {
      ...options.alias,
      "react-devtools-core": reactDevtoolsStub,
    }
  },
  banner: `/**
 * @agentproto/cli v${version}
 * The \`agentproto\` binary — install / run / serve AIP-45 agent CLIs.
 */
// Provide a real \`require\` in the ESM bundle. Bundling the Ink stack pulls in
// CJS deps (e.g. signal-exit@3) that call \`require("assert")\`; without this
// esbuild's interop shim throws "Dynamic require is not supported".
import { createRequire as __agentprotoCreateRequire } from "node:module";
const require = __agentprotoCreateRequire(import.meta.url);`,
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
    // NOTE: the Ink stack (react, ink, ink-text-input, ink-spinner) is
    // deliberately NOT external — it must be bundled so the binary carries
    // its own react@18. When run from inside a host monorepo that has
    // react@19, an external `react` import resolves to the host's react@19
    // and crashes the Ink reconciler (ReactCurrentOwner). Bundling keeps a
    // single, self-contained react copy.
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
    // The Ink stack must be FORCE-bundled. tsup auto-externalizes anything in
    // package.json `dependencies`, so dropping these from `external` isn't
    // enough — they'd still resolve `react` from the host monorepo (react@19)
    // and crash the reconciler. noExternal inlines a single self-contained
    // react@18 copy shared by ink + the TUI.
    "react",
    "react/jsx-runtime",
    "ink",
    "ink-text-input",
    "ink-spinner",
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
