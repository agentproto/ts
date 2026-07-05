/**
 * @agentproto/auth — AIP-50 AUTH.md reference implementation.
 *
 * Public API:
 *   defineAuthProvider(def)           — TS-literal authoring (frozen handle)
 *   parseAuthProviderManifest(source) — .md authoring (gray-matter + Zod)
 *   registerAuthProvider(handle)      — extend the module-level registry
 *   getAuthProvider(id)               — lookup by vendor id
 *   listAuthProviderIds()             — enumerate known providers
 *   discoverEndpoints(apiBase)        — two-hop PRM → AS metadata discovery
 *   runAuthFlow(provider, opts)       — resolve + discover + dispatch to engine
 *   FLOW_ENGINES                      — registered flow engines (pat, …)
 *   writeKeychainToken(svc, acct, t)  — persist a credential to Keychain
 *   readKeychainToken(svc, acct)      — read a credential from Keychain
 *   resolveAccount(acct, server)      — expand {server} template
 *   KeychainStore / MemoryStore / FileStore — built-in CredentialStore backends
 *   resolveStoreRef(spec, server)     — map a TokenStoreSpec to a StoreRef
 */

export { defineAuthProvider } from "./define-auth-provider.js"
export {
  parseAuthProviderManifest,
  parseAuthProviderManifestRaw,
  type AuthProviderManifest,
} from "./manifest.js"
export {
  registerAuthProvider,
  getAuthProvider,
  listAuthProviders,
  listAuthProviderIds,
} from "./registry.js"
export {
  discoverEndpoints,
  DiscoveryError,
} from "./discover.js"
export { runAuthFlow, type RunFlowOptions } from "./run-flow.js"
export { FLOW_ENGINES } from "./flow-engines/index.js"
export {
  readKeychainToken,
  writeKeychainToken,
  resolveAccount,
} from "./token-store.js"
export { KeychainStore } from "./store/keychain-store.js"
export { MemoryStore } from "./store/memory-store.js"
export { FileStore } from "./store/file-store.js"
export { resolveStoreRef } from "./store/resolve-ref.js"
export type {
  CredentialStore,
  StoreRef,
  StoredCredential,
} from "./store/types.js"
export { guildeAuthProvider, BUILTIN_AUTH_PROVIDERS } from "./builtins.js"
export {
  authProviderFrontmatterSchema,
  authConfigSchema,
  tokenStoreSpecSchema,
  installConfigSchema,
  type AuthProviderFrontmatter,
} from "./schema.js"
export type {
  AuthProviderDefinition,
  AuthProviderHandle,
  AuthConfig,
  PATAuthConfig,
  ServiceAuthConfig,
  InstallConfig,
  TokenStoreSpec,
  FlowEngine,
  FlowId,
  FlowResult,
  FlowRunOptions,
  DiscoveredEndpoints,
} from "./types.js"

export const SPEC_NAME = "agentauth"
export const SPEC_VERSION = "v1"
