import { defineWorkflow } from "@agentproto/workflow"

/**
 * The one workflow the content team produces a piece through. Every team
 * agent references it (app-kit attachment invariant).
 *
 * Three declarative `kind:"agent"` steps — researcher → writer → editor —
 * one per team agent, each `agent.ref` resolving (at compile time, against
 * this app's own install record) to that agent's emitted AGENT.md. This
 * replaces an earlier `ToolStep`-based draft (`read_file`/`write_file`/
 * `edit_file`/`run_command`) that dispatched daemon-side, where those tool
 * ids don't exist — they're agent workspace tools (adapter-side), never
 * daemon tool ids, so `app_install` rejected them. Agent steps are the
 * adoption fix: each step spawns the named team agent as a real session,
 * which uses its own workspace tools to read, draft, and edit.
 */
export const produceContent = defineWorkflow({
  id: "produce-content",
  name: "Produce a piece of content",
  description: "Research the sources, draft the piece, then edit it.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    {
      id: "research",
      kind: "agent",
      agent: { ref: "@agentproto/researcher" },
      prompt:
        "Read the source material already in the workspace and hand off a tight " +
        "brief with a citation for every claim.",
    },
    {
      id: "draft",
      kind: "agent",
      agent: { ref: "@agentproto/writer" },
      prompt: "Draft the piece from the researcher's brief and its sources.",
    },
    {
      id: "edit",
      kind: "agent",
      agent: { ref: "@agentproto/editor" },
      prompt: "Edit the draft for voice, clarity, and length, then finalize it.",
    },
  ],
})
