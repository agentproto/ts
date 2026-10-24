import { defineAgent } from "@agentproto/agent"
import type { AgentEntry } from "@agentproto/app-kit"

/** Applies the reviewer's findings, precisely and minimally. */
export const fixer: AgentEntry = {
  agent: defineAgent({
    schema: "agent/v1",
    id: "@agentproto/fixer",
    description: "Applies the reviewer's findings, precisely and minimally.",
    model: "claude-sonnet-5",
    boundaries: ["Apply only the listed findings", "No unrelated refactors"],
    tools: ["list_dir", "read_file", "write_file", "edit_file", "run_command"],
    workflows: [{ ref: "deliver-change" }],
  }),
  body:
    "You apply the reviewer's findings. Address each listed finding exactly, add " +
    "nothing extra, and re-run the tests when done.",
}
