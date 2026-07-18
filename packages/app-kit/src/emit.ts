/**
 * `emitApp(app, dir)` — write an app's agents + workflows to disk under an
 * agentproto-owned base, so the manifests don't squat the shared root
 * `.agents/` convention:
 *
 *   <dir>/.agentproto/agents/<id>/AGENT.md         (one per agent)
 *   <dir>/.agentproto/workflows/<wf.id>/WORKFLOW.md (shared — a workflow may
 *                                                    be run by several agents)
 *
 * The `tenants/<t>/…` segment the daemon's state root is migrating toward
 * (AIP-46 / DESIGN.md §9) is deliberately NOT invented here yet — it lands
 * once the daemon's tenant layer does.
 *
 * Both are plain markdown manifests: frontmatter = the validated handle,
 * body = the agent's `body` (its system prompt) or the workflow description.
 * Because a `defineWorkflow` handle is pure data, the WORKFLOW.md needs no
 * `entry:` module — the manifest *is* the workflow, so `loadWorkflowHandle`
 * returns it directly with nothing to reconcile against.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import matter from "gray-matter"
import type { WorkflowHandle } from "@agentproto/workflow"
import type { AgentEntry, EmittedApp } from "./types.js"
import { stripOwner } from "./refs.js"

interface EmitInput {
  readonly agents: readonly AgentEntry[]
  readonly workflows: readonly WorkflowHandle[]
}

export async function emitApp(app: EmitInput, dir: string): Promise<EmittedApp> {
  const agentPaths: Record<string, string> = {}
  for (const { agent, body } of app.agents) {
    const agentDir = join(dir, ".agentproto", "agents", stripOwner(agent.id))
    await mkdir(agentDir, { recursive: true })
    const agentPath = join(agentDir, "AGENT.md")
    await writeFile(agentPath, toManifest(agent, body ?? ""), "utf8")
    agentPaths[agent.id] = agentPath
  }

  const workflowPaths: string[] = []
  for (const wf of app.workflows) {
    const wfDir = join(dir, ".agentproto", "workflows", wf.id)
    await mkdir(wfDir, { recursive: true })
    const wfPath = join(wfDir, "WORKFLOW.md")
    await writeFile(wfPath, toManifest(wf, wf.description ?? ""), "utf8")
    workflowPaths.push(wfPath)
  }

  return { agentPaths, workflowPaths }
}

/**
 * Serialize a handle to a `.md` manifest. gray-matter's YAML engine
 * rejects `undefined` values; a JSON clone drops them and yields a plain
 * data object (AIP handles are pure data, no functions/Dates) that
 * round-trips through the matching `parse*Manifest`. gray-matter appends
 * a trailing newline, so manifests end in exactly one newline.
 */
function toManifest(handle: object, body: string): string {
  const data: Record<string, unknown> = JSON.parse(JSON.stringify(handle))
  return matter.stringify(`\n${body}\n`, data)
}
