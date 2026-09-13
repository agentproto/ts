import { execSync } from "node:child_process"
import { copyFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { createTsupConfig } from "@agentproto/tooling/tsup/base"

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
)

// Build identity, embedded so a running daemon can say WHICH build it is
// (version alone can't: a workspace dist and the published tarball of the
// same release both report e.g. "0.13.0"). Best-effort: a tarball rebuild
// outside git gets empty strings, and consumers render that as "unknown".
const gitSha = (() => {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: new URL(".", import.meta.url).pathname,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
  } catch {
    return ""
  }
})()
const builtAt = new Date().toISOString()

export default createTsupConfig({
  define: {
    __CLI_VERSION__: JSON.stringify(version),
    __CLI_BUILD_SHA__: JSON.stringify(gitSha),
    __CLI_BUILT_AT__: JSON.stringify(builtAt),
  },
  banner: `/**
 * @agentproto/cli v${version}
 * The \`agentproto\` binary — install / run / serve AIP-45 agent CLIs.
 */
// Provide a real \`require\` in the ESM bundle. Some bundled deps (e.g.
// gray-matter, node-pty) are CJS and call \`require("assert")\` or similar;
// without this esbuild's interop shim throws "Dynamic require is not supported".
import { createRequire as __agentprotoCreateRequire } from "node:module";
const require = __agentprotoCreateRequire(import.meta.url);`,
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    "registry/runtime": "src/registry/runtime.ts",
    "registry/builtins": "src/registry/builtins.ts",
    "registry/adapters": "src/registry/adapters.ts",
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
      "registry/adapters": "src/registry/adapters.ts",
      "registry/manifest": "src/registry/manifest.ts",
      "util/credentials": "src/util/credentials.ts",
    },
  },
  external: [
    "@agentproto/acp",
    "@agentproto/driver",
    "@agentproto/driver-agent-cli",
    // Independently-published workspace packages consumed both directly by the
    // pairing CLI (`pair`, `rendezvous`) and transitively by the bundled runtime
    // dist. Externalised (like @agentproto/acp) so the published cli installs
    // them via npm; declared under `dependencies` in package.json.
    "@agentproto/secrets",
    "@agentproto/secrets/*",
    "@agentproto/rendezvous",
    "@agentproto/rendezvous/*",
    // Loaded via a runtime dynamic import by the bundled runtime's sandbox
    // registry (`import("@agentproto/sandbox-e2b")` / `import("@agentproto/
    // sandbox-box")` resolves from the CLI package's own node_modules
    // because the runtime is bundled into cli.mjs) — MUST stay external AND
    // declared under `dependencies`, or `agent_start sandbox:"e2b"`/
    // `agentproto sandbox attach box ...` fails with "provider not found".
    "@agentproto/sandbox-e2b",
    "@agentproto/sandbox-box",
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
    // create-agentproto-app resolves its templates/ tree relative to its OWN
    // module (`new URL("../templates", import.meta.url)` in scaffold.ts) —
    // bundling it would bake a cli/dist/templates path that doesn't exist.
    // Externalised so it (and its published templates/) resolves from
    // node_modules; declared under `dependencies` in package.json.
    "create-agentproto-app",
    "create-agentproto-app/*",
    // pi-tui is externalised — it's pure ESM with no monorepo react conflict.
    // Chalk is also externalised (it's widely available and ESM-safe).
    "@earendil-works/pi-tui",
    // ajv is CJS with a dynamic require of its runtime codegen — externalise
    // it (like the other CJS deps) so the published cli resolves it from
    // node_modules instead of an unsafe inlined bundle.
    "ajv",
    "chalk",
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
    // @ast-grep/napi ships per-platform native .node bindings selected by
    // a switch in its own JS shim, and is pulled in transitively (@mastra/
    // core -> its bundled workspace/code-search tooling does a dynamic
    // `import("@ast-grep/napi")`, reachable once @agentproto/runtime ->
    // @agentproto/app-kit -> @agentproto/mastra is bundled into cli.mjs).
    // Bundling it makes esbuild statically resolve every platform branch
    // in that shim, which fails for every platform's binary except
    // whichever one happens to be installed locally. Externalise it like
    // node-pty so it resolves from node_modules at runtime instead.
    "@ast-grep/napi",
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
  // The stage board module is a plain-JS asset served verbatim by
  // `app serve` / `app dev` (see src/stageboard/serve.ts) — esbuild only
  // bundles TS entries, so copy it into dist next to cli.mjs where the
  // runtime URL lookup lands.
  onSuccess: async () => {
    await copyFile(
      new URL("./src/stageboard/stageboard.js", import.meta.url),
      new URL("./dist/stageboard.js", import.meta.url),
    )
  },
})
