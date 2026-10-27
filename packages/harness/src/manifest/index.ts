/**
 * AIP-45 AGENT-CLI.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/skill/manifest` and `@agentproto/acp/manifest`:
 * the .md provides metadata; the TS runtime supplies any spec-specific
 * runtime bits. Both inputs end up in `defineAgentCli` so the cross-AIP
 * invariants run uniformly.
 */

import matter from "gray-matter"
import {
  agentCliFrontmatterSchema,
  type AgentCliFrontmatter,
} from "../schema.js"
import { defineAgentCli } from "../define-agent-cli.js"
import type { AgentCliDefinition, AgentCliHandle } from "../types.js"

export { agentCliFrontmatterSchema, type AgentCliFrontmatter }

export interface AgentCliManifest {
  frontmatter: AgentCliFrontmatter
  body: string
}

export function parseAgentCliManifest(source: string): AgentCliManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseAgentCliManifest: missing or empty frontmatter")
  }
  const result = agentCliFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseAgentCliManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function agentCliFromManifest(
  manifest: AgentCliManifest,
): AgentCliHandle {
  return defineAgentCli(manifest.frontmatter as unknown as AgentCliDefinition)
}
