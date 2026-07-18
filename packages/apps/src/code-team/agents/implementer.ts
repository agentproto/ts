import { defineAgent } from "@agentproto/agent"
import type { AgentEntry } from "@agentproto/app-kit"

/** Writes the requested change. */
export const implementer: AgentEntry = {
  agent: defineAgent({
    schema: "agent/v1",
    id: "@agentproto/implementer",
    description: "Implements the requested code change.",
    model: "claude-sonnet-5",
    boundaries: ["Change only what the task asks", "Match the surrounding style"],
    workflows: [{ ref: "deliver-change" }],
  }),
  body:
    "You implement the requested change. Read the task and the surrounding code " +
    "first, make the smallest correct change that satisfies it, then run the " +
    "tests. Do not touch anything the task didn't ask for.",
}
