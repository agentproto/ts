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
export {
  resolveAdapter,
  listInstalledAdapters,
} from "./registry/resolve.js"
export type {
  ResolvedAdapter,
  AdapterInfo,
} from "./registry/resolve.js"
