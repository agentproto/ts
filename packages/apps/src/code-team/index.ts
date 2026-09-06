/**
 * `code-team` — a ready-made agentproto app: a small team that ships a code
 * change. Three agents (implementer → reviewer → fixer) bound to one delivery
 * workflow, declared with `@agentproto/app-kit`.
 *
 * Generic on purpose — `@agentproto/…` ids, no product dependency, no home
 * workspace. A host imports it and uses any subset of its agents/workflows:
 * in-process via `codeTeam.toMastraAgents(...)`, or on disk via
 * `codeTeam.emit(dir)`.
 */

import { defineApp, type AppHandle } from "@agentproto/app-kit"
import { implementer } from "./agents/implementer.js"
import { reviewer } from "./agents/reviewer.js"
import { fixer } from "./agents/fixer.js"
import { deliverChange } from "./workflows/deliver-change.js"

export const codeTeam: AppHandle = defineApp({
  id: "@agentproto/code-team",
  name: "Code Team",
  version: "0.1.0",
  description: "Implement, review, and fix code changes.",
  agents: [implementer, reviewer, fixer],
  workflows: [deliverChange],
})

export { implementer, reviewer, fixer, deliverChange }
