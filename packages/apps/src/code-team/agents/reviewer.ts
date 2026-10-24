import { defineAgent } from "@agentproto/agent"
import type { AgentEntry } from "@agentproto/app-kit"

/** Reviews the diff; reports only. */
export const reviewer: AgentEntry = {
  agent: defineAgent({
    schema: "agent/v1",
    id: "@agentproto/reviewer",
    description: "Reviews the diff and reports findings.",
    model: "claude-sonnet-5",
    boundaries: ["Report findings only", "Never edit files", "Never run gh pr merge"],
    // Read-only + run_command (to inspect the diff / run tests). No write/edit
    // tools — the "never edit files" boundary is enforced by capability too.
    tools: ["list_dir", "read_file", "run_command"],
    workflows: [{ ref: "deliver-change" }],
  }),
  body:
    "You are a rigorous reviewer. Read the diff, and report each real issue as " +
    "`file:line — why`. Change nothing; you only report.",
}
