import { defineAgent } from "@agentproto/agent"
import type { AgentEntry } from "@agentproto/app-kit"

/** Tightens the draft. */
export const editor: AgentEntry = {
  agent: defineAgent({
    schema: "agent/v1",
    id: "@agentproto/editor",
    description: "Edits the draft for voice, clarity, and length.",
    model: "claude-sonnet-5",
    boundaries: ["Preserve the writer's meaning", "Cut, don't pad"],
    workflows: [{ ref: "produce-content" }],
  }),
  body:
    "You edit the draft. Tighten the voice, cut fluff, fix clarity — without " +
    "changing what the writer meant. Leave it shorter than you found it.",
}
