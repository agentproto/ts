/**
 * agentagencies/v1 runtime — FS-only helpers.
 *
 * NO Mastra, LangChain, Temporal imports. The vendor-neutral runtime that any
 * orchestrator can consume. Vendor adapters (e.g., @agentproto/agencies-mastra) wrap
 * these helpers with workflow-specific suspend/resume primitives.
 */

export {
  computeAgencyOverview,
  type ComputeAgencyOverviewInput,
  type ComputeAgencyOverviewResult,
} from "./compute-agency-overview.js"

/** Workspace-relative path of the snapshot the routine writes. */
export const AGENCY_OVERVIEW_SNAPSHOT_PATH =
  "_snapshots/agency-overview.json" as const

/** Path of the bundled rollup snippets folder (relative to the package root). */
export const AGENCY_OVERVIEW_ROLLUP_SNIPPET_PATH =
  "src/spec/snippets/agency-overview-rollup" as const
