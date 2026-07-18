import { defineWorkflow } from "@agentproto/workflow"

/** The one workflow the code team delivers a change through. Every team agent
 *  references it; the app-kit attachment invariant keeps that honest. */
export const deliverChange = defineWorkflow({
  id: "deliver-change",
  name: "Deliver a code change",
  description: "Implement the change, review the diff, apply fixes, verify.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    { id: "implement", kind: "tool", tool: "apply_patch" },
    { id: "review", kind: "tool", tool: "read_diff" },
    { id: "fix", kind: "tool", tool: "apply_patch" },
    { id: "verify", kind: "tool", tool: "run_tests" },
  ],
})
