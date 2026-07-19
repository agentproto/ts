import { defineWorkflow } from "@agentproto/workflow"

/** The one workflow the content team produces a piece through. Every team
 *  agent references it (app-kit attachment invariant). */
export const produceContent = defineWorkflow({
  id: "produce-content",
  name: "Produce a piece of content",
  description: "Read the sources, draft the piece, edit it, then commit it.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  // Concrete workspace tools (fs + exec), so the workflow describes a process
  // a standard runtime can actually run — not abstract tools nothing provides.
  steps: [
    { id: "research", kind: "tool", tool: "read_file" },
    { id: "draft", kind: "tool", tool: "write_file" },
    { id: "edit", kind: "tool", tool: "edit_file" },
    { id: "publish", kind: "tool", tool: "run_command" },
  ],
})
