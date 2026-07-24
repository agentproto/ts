/**
 * @agentproto/adapter-code-brain-gbrain — the impure gbrain backing for the
 * pure `@agentproto/code-brain` `ICodeBrainProvider` contract.
 *
 * Ships two contract implementations (local `docker exec` + remote MCP/HTTP),
 * a provider-kit family that registers them, the tracked `ask_codebase` MCP
 * server, and the relocated gbrain runtime (`runtime/`). Every gbrain idiom
 * (`code-def`, `__all__`, `--source-id`, bearer auth) is confined to this
 * package — `@agentproto/code-brain` and everything above it stay
 * backend-agnostic.
 */

// backends
export { GbrainLocalProvider, gbrainLocalProvider } from "./gbrain-local.js"
export { GbrainHttpProvider, gbrainHttpProvider, extractJsonRpcPayload } from "./gbrain-http.js"

// typed env
export {
  loadGbrainLocalEnv,
  loadGbrainHttpEnv,
  loadCodeBrainMcpServerEnv,
  type GbrainLocalEnv,
  type GbrainHttpEnv,
  type CodeBrainMcpServerEnv,
} from "./env.js"

// provider-kit family
export {
  CODE_BRAIN_FAMILY,
  CODE_BRAIN_CATALOG,
  GBRAIN_LOCAL_SLUG,
  GBRAIN_HTTP_SLUG,
} from "./catalog.js"
export {
  resolveCodeBrainBackend,
  makeCodeBrainResolver,
  type CodeBrainInfo,
  type CodeBrainHandle,
} from "./handle.js"

// parsers (gbrain dialect → contract types)
export {
  parseSymbolDef,
  parseCallEdges,
  parseQueryText,
  parseQueryJson,
  extractLocation,
} from "./parse.js"

// ask_codebase MCP server (tracked replacement for the home-dir script)
export {
  runAskCodebase,
  createAskCodebaseMcpServer,
  startAskCodebaseHttpServer,
  type AskCodebaseHttpServer,
  type StartAskCodebaseHttpServerOptions,
} from "./mcp-server.js"
