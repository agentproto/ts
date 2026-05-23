/**
 * @agentproto/corpus-cli — programmatic API.
 *
 * The CLI binary is the primary surface; this module re-exports the
 * port adapters + version so callers embedding the corpus runtime in
 * their own Node process (e.g. Electron host) don't shell out to the
 * binary.
 */

export { VERSION } from "./version.js"
export {
  NodeFsAdapter,
  OsIdentityAdapter,
} from "./ports/index.js"
export type {
  NodeFsAdapterOptions,
  OsIdentityAdapterOptions,
} from "./ports/index.js"
