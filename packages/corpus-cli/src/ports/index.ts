/**
 * @agentproto/corpus-cli/ports — local-topology port implementations.
 *
 * Concrete adapters that satisfy @agentproto/corpus's port interfaces
 * for a single-user, single-machine deployment. Cloud topology
 * (Guilde apps/api/services/corpus-host) ships its own adapters.
 */

export { NodeFsAdapter } from "./local-fs.adapter.js"
export type { NodeFsAdapterOptions } from "./local-fs.adapter.js"

export { OsIdentityAdapter } from "./os-identity.adapter.js"
export type { OsIdentityAdapterOptions } from "./os-identity.adapter.js"
