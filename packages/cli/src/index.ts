/**
 * @agentproto/cli — programmatic API.
 *
 * The primary surface is the `agentproto` binary (see ./cli.ts). This
 * module re-exports the verb implementations so they can be embedded
 * in other tooling (e.g. integration tests, IDE extensions).
 */

export { runInstall } from "./commands/install.js"
export { runRun } from "./commands/run.js"
export { runServe } from "./commands/serve.js"
export { runAcp } from "./commands/acp.js"
export { runPreset } from "./commands/preset.js"
export { runProviderPresets } from "./commands/presets.js"
export { runPackSkill } from "./commands/pack.js"
export { zipPackDir } from "./commands/skill-install/zip-pack.js"
export type { ZipPackResult } from "./commands/skill-install/zip-pack.js"
export {
  resolveAdapter,
  listInstalledAdapters,
  listAdaptersWithCatalog,
  listAdaptersWithAcp,
} from "./registry/resolve.js"
export type {
  ResolvedAdapter,
  AdapterInfo,
  AdapterListing,
} from "./registry/resolve.js"
export {
  acpHandleFromSpec,
  ACP_CATALOG,
  resolveAcpSpec,
  listAcpGenericAdapters,
  binOnPath,
} from "./registry/acp-generic.js"
export type {
  AcpAgentSpec,
  AcpSpecSource,
  AcpGenericListEntry,
} from "./registry/acp-generic.js"
