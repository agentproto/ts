/**
 * The one AGENT.md renderer. `emitApp`, `renderAgentManifest` (app), the
 * `agent create|update` verbs (`agentVerbs`) and the daemon's `create_agent`
 * all produce their file through `renderAgentMd`, so the same agent renders
 * to the same bytes whichever path wrote it.
 */

import matter from "gray-matter"
import type { AgentHandle } from "./types.js"

/**
 * An agent handle paired with its AGENT.md body (AIP-42 §The `defineAgent`
 * standard signature; same shape as AIP-53's `AgentEntry`).
 */
export interface AgentEntry {
  readonly agent: AgentHandle
  /** The system prompt (AIP-42 rule 3). Composed from the structured fields when absent. */
  readonly body?: string
}

/**
 * Serialise an agent entry to AGENT.md text: `agent/v1` frontmatter, then the
 * trimmed body. The body is trimmed so that rendering a file read back from
 * disk gives the same bytes (an update does not grow blank lines).
 */
export function renderAgentMd(entry: AgentEntry): string {
  const { schema: _schema, ...fields } = entry.agent
  // JSON round-trip drops undefined and any non-JSON value, so the frontmatter stays plain YAML.
  const data: Record<string, unknown> = JSON.parse(
    JSON.stringify({ schema: "agent/v1", ...fields }),
  )
  return matter.stringify(`\n${(entry.body ?? "").trim()}\n`, data)
}
