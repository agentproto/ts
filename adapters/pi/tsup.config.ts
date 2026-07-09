import { createTsupConfig } from "@agentproto/tooling/tsup/base"

/**
 * Two bundles:
 *  - `index.mjs`: the adapter. Bundles `@modelcontextprotocol/sdk` (used to
 *    enumerate MCP tools in connect()); `@agentproto/driver-agent-cli` external.
 *  - `mcp-bridge-extension.mjs`: the pi extension pi loads via `-e`. Bundles the
 *    MCP SDK (pi's process has no other way to load it); pi's own packages
 *    (`@earendil-works/*`) are never imported here (structural typing), and node
 *    builtins stay external. `splitting: false` keeps it fully self-contained so
 *    pi/jiti loads a single file with no sibling chunks.
 */
export default createTsupConfig({
  banner: `/**
 * @agentproto/adapter-pi v0.1.0
 * AIP-45 proprietary protocol arm for earendil-works/pi, driven over pi's
 * persistent JSON-over-stdio RPC mode (\`pi --mode rpc\`) as a spawned child.
 * Second entry \`mcp-bridge-extension.mjs\` is the pi extension that bridges
 * injected MCP servers into pi tools (see MCP-BRIDGE.md).
 */
// ESM interop: the inlined MCP SDK pulls in CJS deps (e.g. cross-spawn) that
// \`require()\` node builtins. Provide a real \`require\` so esbuild's __require
// helper uses it instead of throwing "Dynamic require ... is not supported".
import { createRequire as __agp_createRequire } from "module"
const require = __agp_createRequire(import.meta.url)`,
  entry: {
    index: "src/index.ts",
    "mcp-bridge-extension": "src/mcp-bridge/extension.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: { entry: { index: "src/index.ts" } },
  external: ["@agentproto/driver-agent-cli"],
  // tsup externalizes `dependencies` by default. Force the MCP SDK to be
  // INLINED: the bridge extension runs inside pi's process, which cannot
  // resolve `@modelcontextprotocol/sdk` — it must be self-contained. (The
  // adapter's own `index.mjs` inlines it too; harmless, and keeps a single
  // build.) Regex catches the SDK's deep subpath imports.
  noExternal: [/@modelcontextprotocol\/sdk/],
})
