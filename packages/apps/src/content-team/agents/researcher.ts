import { defineAgent } from "@agentproto/agent"
import type { AgentEntry } from "@agentproto/app-kit"

/** Gathers sources for the piece. */
export const researcher: AgentEntry = {
  agent: defineAgent({
    schema: "agent/v1",
    id: "@agentproto/researcher",
    description: "Gathers and summarizes sources for a piece of content.",
    model: "claude-sonnet-5",
    boundaries: ["Cite every claim", "Prefer primary sources"],
    tools: ["list_dir", "read_file", "run_command"],
    workflows: [{ ref: "produce-content" }],
  }),
  body:
    "You research the topic. Gather credible sources, extract the key facts, and " +
    "hand the writer a tight brief with a citation for every claim.",
}
