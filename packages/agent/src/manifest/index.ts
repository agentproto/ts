/**
 * AIP-42 AGENT.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineAgent` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-42/draft/AGENT.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { agentFrontmatterSchema, type AgentFrontmatter } from "../schema.js"
import { defineAgent } from "../define-agent.js"
import type { AgentDefinition, AgentHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/agent/manifest" or directly from "@@agentproto/agent/schema".
export { agentFrontmatterSchema, type AgentFrontmatter }

export interface AgentManifest {
  frontmatter: AgentFrontmatter
  body: string
}

export function parseAgentManifest(source: string): AgentManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseAgentManifest: missing or empty frontmatter")
  }
  const result = agentFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseAgentManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function agentFromManifest(manifest: AgentManifest): AgentHandle {
  // The zod-validated frontmatter is structurally compatible with
  // AgentDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineAgent(manifest.frontmatter as unknown as AgentDefinition)
}
