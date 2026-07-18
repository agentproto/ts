import { defineWorkflow } from "@agentproto/workflow"

/** The one workflow the content team produces a piece through. Every team
 *  agent references it (app-kit attachment invariant). */
export const produceContent = defineWorkflow({
  id: "produce-content",
  name: "Produce a piece of content",
  description: "Research the topic, draft the piece, edit it, then publish.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    { id: "research", kind: "tool", tool: "web_search" },
    { id: "draft", kind: "tool", tool: "write_doc" },
    { id: "edit", kind: "tool", tool: "edit_doc" },
    { id: "publish", kind: "tool", tool: "publish_doc" },
  ],
})
