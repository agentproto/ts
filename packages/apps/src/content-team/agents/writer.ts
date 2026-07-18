import { defineAgent } from "@agentproto/agent"
import type { AgentEntry } from "@agentproto/app-kit"

/** Drafts the piece from the brief. */
export const writer: AgentEntry = {
  agent: defineAgent({
    schema: "agent/v1",
    id: "@agentproto/writer",
    description: "Drafts the piece from the researcher's brief.",
    model: "claude-sonnet-5",
    boundaries: ["Stay on the brief", "One idea per paragraph"],
    workflows: [{ ref: "produce-content" }],
  }),
  body:
    "You draft the piece from the brief and its sources. Lead with the point, " +
    "keep one idea per paragraph, and don't invent facts the brief doesn't have.",
}
