/**
 * AIP-42 doctype spec — fed to `@agentproto/manifest.createVerbs`
 * to derive create / load / list / update / resolve / delete in one
 * place. Plugs into `@agentproto/mcp-server` so an agent library
 * lives at `<workspace>/.agents/<id>/AGENT.md` (mirroring AIP-39's
 * `.actions/` convention).
 */

import { createVerbs, type DoctypeSpec } from "@agentproto/manifest"
import { defineAgent } from "./define-agent.js"
import { parseAgentManifest } from "./manifest/index.js"
import type { AgentDefinition, AgentHandle } from "./types.js"

export const agentSpec: DoctypeSpec<AgentDefinition, AgentHandle> = {
  name: "agent",
  aip: 42,
  schemaLiteral: "agent/v1",
  pathOf: (h) => `.agents/${h.id}/AGENT.md`,
  define: defineAgent,
  parse: (source) => {
    const m = parseAgentManifest(source)
    return {
      frontmatter: m.frontmatter as unknown as Record<string, unknown>,
      body: m.body,
    }
  },
}

export const agentVerbs = createVerbs(agentSpec)
