import { defineAgent } from "@agentproto/agent"
import type { AgentEntry } from "@agentproto/app-kit"

/** Gathers sources for the piece. */
export const researcher: AgentEntry = {
  agent: defineAgent({
    schema: "agent/v1",
    id: "@agentproto/researcher",
    description: "Reads the provided sources and summarizes them for the writer.",
    model: "claude-sonnet-5",
    boundaries: ["Cite every claim", "Prefer primary sources"],
    tools: ["list_dir", "read_file", "run_command"],
    workflows: [{ ref: "produce-content" }],
  }),
  body:
    "You read the source material already in the workspace (list_dir, then " +
    "read_file the sources), extract the key facts, and hand the writer a tight " +
    "brief with a citation for every claim. Use run_command only to fetch a URL " +
    "already named in the task; do not invent sources.",
}
