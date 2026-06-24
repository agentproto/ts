/**
 * @agentproto/adapter-kit — public surface.
 *
 * Generic adapter catalog, status, creds, setup-ledger, list/resolve, MCP
 * tool, and CLI wizard primitives shared by the agent-CLI, browser, and
 * tunnel adapter families. The kit owns the skeleton; each family supplies
 * its own `TInfo` descriptor and `THandle` (extends `AdapterHandle`).
 */

// types
export type {
  AdapterStatus,
  AdapterCatalogEntry,
  AdapterCatalog,
  AdapterEntry,
  AdapterHandle,
  SetupLedgerRecord,
  AdapterResolver,
  AdapterLister,
} from "./types.js"

// creds
export { makeCredsStore } from "./creds-store.js"
export type { CredsStore, MakeCredsStoreOpts } from "./creds-store.js"

// ledger
export { makeSetupLedger } from "./ledger.js"
export type { SetupLedger, MakeSetupLedgerOpts } from "./ledger.js"

// status
export { computeStatus } from "./status.js"
export type { ComputeStatusOpts } from "./status.js"

// list / resolve
export { makeAdapterResolver, makeAdapterLister } from "./list-resolve.js"
export type {
  MakeAdapterResolverOpts,
  MakeAdapterListerOpts,
} from "./list-resolve.js"

// MCP tools
export { makeListTool, makeSetupTool } from "./mcp-tools.js"
export type { SetupField, MakeListToolOpts, MakeSetupToolOpts } from "./mcp-tools.js"

// wizard
export { makeAdapterWizard } from "./wizard.js"
export type {
  AdapterWizardStep,
  AdapterWizard,
  MakeAdapterWizardOpts,
  WizardRunOpts,
  WizardStepResult,
} from "./wizard.js"
