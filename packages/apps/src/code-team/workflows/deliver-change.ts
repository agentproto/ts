import { defineWorkflow } from "@agentproto/workflow"

/**
 * The one workflow the code team delivers a change through. Every team agent
 * references it; the app-kit attachment invariant keeps that honest.
 *
 * Three declarative `kind:"agent"` steps — implementer → reviewer → fixer —
 * one per team agent, each `agent.ref` resolving (at compile time, against
 * this app's own install record) to that agent's emitted AGENT.md. This
 * replaces an earlier `ToolStep`-based draft (`apply_patch`/`read_diff`/
 * `run_tests`) that dispatched daemon-side, where those tool ids don't
 * exist — the daemon has no `apply_patch` tool, only live agent sessions
 * that can edit files. Agent steps are the adoption fix (WP-B4): each step
 * spawns the named team agent as a real session and lets it act.
 */
export const deliverChange = defineWorkflow({
  id: "deliver-change",
  name: "Deliver a code change",
  description: "Implement the change, review the diff, apply fixes, verify.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    {
      id: "implement",
      kind: "agent",
      agent: { ref: "@agentproto/implementer" },
      prompt: "Implement the requested change.",
    },
    {
      id: "review",
      kind: "agent",
      agent: { ref: "@agentproto/reviewer" },
      prompt:
        "Review the diff the implementer just produced. Report every real issue as `file:line — why`.",
    },
    {
      id: "fix",
      kind: "agent",
      agent: { ref: "@agentproto/fixer" },
      prompt: "Apply the reviewer's findings, then re-run the tests.",
    },
  ],
})
