/**
 * `code-team` — a ready-made agentproto app: a small team that ships a code
 * change. Three agents (implementer → reviewer → fixer) bound to one delivery
 * workflow, declared with `@agentproto/app-kit`.
 *
 * Generic on purpose — the ids are `@agentproto/…`, it depends on no product
 * package, and it carries no home workspace. A host (e.g. agentik-studio)
 * imports it and uses any subset of its agents/workflows: in-process via
 * `codeTeam.toMastraAgents(...)`, or on disk via `codeTeam.emit(dir)`.
 */

import { defineApp, type AppHandle } from "@agentproto/app-kit"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"

/** The one workflow the team delivers a change through. Every team agent
 *  references it; the app-kit attachment invariant keeps that honest. */
const deliverChange = defineWorkflow({
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

const implementer = defineAgent({
  schema: "agent/v1",
  id: "@agentproto/implementer",
  description: "Implements the requested code change.",
  model: "claude-sonnet-5",
  boundaries: ["Change only what the task asks", "Match the surrounding style"],
  workflows: [{ ref: "deliver-change" }],
})

const reviewer = defineAgent({
  schema: "agent/v1",
  id: "@agentproto/reviewer",
  description: "Reviews the diff and reports findings.",
  model: "claude-sonnet-5",
  boundaries: ["Report findings only", "Never edit files", "Never run gh pr merge"],
  workflows: [{ ref: "deliver-change" }],
})

const fixer = defineAgent({
  schema: "agent/v1",
  id: "@agentproto/fixer",
  description: "Applies the reviewer's findings, precisely and minimally.",
  model: "claude-sonnet-5",
  boundaries: ["Apply only the listed findings", "No unrelated refactors"],
  workflows: [{ ref: "deliver-change" }],
})

/**
 * The `code-team` app. Import it and pick what you need:
 *
 *   import { codeTeam } from "@agentproto/apps/code-team"
 *   const built = await codeTeam.toMastraAgents({ resolveModel })
 *   built["@agentproto/reviewer"].agent   // just the reviewer
 */
export const codeTeam: AppHandle = defineApp({
  agents: [
    {
      agent: implementer,
      body:
        "You implement the requested change. Read the task and the surrounding " +
        "code first, make the smallest correct change that satisfies it, then " +
        "run the tests. Do not touch anything the task didn't ask for.",
    },
    {
      agent: reviewer,
      body:
        "You are a rigorous reviewer. Read the diff, and report each real issue " +
        "as `file:line — why`. Change nothing; you only report.",
    },
    {
      agent: fixer,
      body:
        "You apply the reviewer's findings. Address each listed finding exactly, " +
        "add nothing extra, and re-run the tests when done.",
    },
  ],
  workflows: [deliverChange],
})
