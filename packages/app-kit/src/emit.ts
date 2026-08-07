/**
 * `emitApp(app, dir)` — write an app's agents + workflows to disk under an
 * agentproto-owned base, so the manifests don't squat the shared root
 * `.agents/` convention:
 *
 *   <dir>/WORKSPACE.md                              (when the app has a
 *                                                    workspace — AIP-34 root
 *                                                    manifest; owner = tenant)
 *   <dir>/.agentproto/agents/<id>/AGENT.md         (one per agent)
 *   <dir>/.agentproto/workflows/<wf.id>/WORKFLOW.md (shared — a workflow may
 *                                                    be run by several agents)
 *   <dir>/.agentproto/APP.md                       (root index — always
 *                                                    written, so a future
 *                                                    `app_install` can
 *                                                    discover the bundle)
 *
 * The "tenant" isn't a `tenants/<t>/…` path segment — it's the `owner` of
 * the AIP-34 WORKSPACE.md (guild / user / org), and local storage is its
 * AIP-35 `storage` block. So there is no bespoke tenant folder to invent.
 *
 * All manifests are plain markdown: frontmatter = the validated handle (or,
 * for APP.md, the identity + a manifest of `{ id, path }` refs to every
 * agent/workflow it bundles), body = the agent's `body` (its system prompt),
 * the workflow description, or the app description. Because a
 * `defineWorkflow` handle is pure data, the WORKFLOW.md needs no `entry:`
 * module — the manifest *is* the workflow, so `loadWorkflowHandle` returns
 * it directly with nothing to reconcile against.
 *
 * `emitApp` stays dependency-light on purpose (no Mastra import) — that
 * split lets a host write/discover an app without paying for the Mastra
 * build path.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import matter from "gray-matter"
import type { WorkflowHandle } from "@agentproto/workflow"
import type { WorkspaceHandle } from "@agentproto/workspace"
import type { AgentEntry, EmittedApp } from "./types.js"
import { stripOwner } from "./refs.js"

interface EmitInput {
  readonly agents: readonly AgentEntry[]
  readonly workflows: readonly WorkflowHandle[]
  readonly workspace?: WorkspaceHandle
  readonly id?: string
  readonly name?: string
  readonly version?: string
  readonly description?: string
  readonly requires?: readonly string[]
}

export async function emitApp(app: EmitInput, dir: string): Promise<EmittedApp> {
  // Root WORKSPACE.md (AIP-34): the workspace manifest whose `owner` names
  // the tenant and whose `storage` names the backing store. The agents +
  // workflows below live *inside* this workspace, under `.agentproto/`.
  let workspacePath: string | undefined
  if (app.workspace) {
    await mkdir(dir, { recursive: true })
    workspacePath = join(dir, "WORKSPACE.md")
    await writeFile(
      workspacePath,
      toManifest(app.workspace, app.workspace.description ?? app.workspace.name),
      "utf8",
    )
  }

  const agentPaths: Record<string, string> = {}
  for (const { agent, body } of app.agents) {
    const agentDir = join(dir, ".agentproto", "agents", stripOwner(agent.id))
    await mkdir(agentDir, { recursive: true })
    const agentPath = join(agentDir, "AGENT.md")
    await writeFile(agentPath, toManifest(agent, body ?? ""), "utf8")
    agentPaths[agent.id] = agentPath
  }

  const workflowPaths: string[] = []
  const workflowRefs: { id: string; path: string }[] = []
  for (const wf of app.workflows) {
    const wfDir = join(dir, ".agentproto", "workflows", wf.id)
    await mkdir(wfDir, { recursive: true })
    const wfPath = join(wfDir, "WORKFLOW.md")
    await writeFile(wfPath, toManifest(wf, wf.description ?? ""), "utf8")
    workflowPaths.push(wfPath)
    workflowRefs.push({ id: wf.id, path: relative(dir, wfPath) })
  }

  // Root APP.md (this WP): the index a future `app_install` reads to
  // discover the bundle — always written, unlike WORKSPACE.md which is
  // conditional on the app having a home workspace.
  await mkdir(join(dir, ".agentproto"), { recursive: true })
  const appPath = join(dir, ".agentproto", "APP.md")
  const agentRefs = app.agents.map(({ agent }) => ({
    id: agent.id,
    path: relative(dir, agentPaths[agent.id]!),
  }))
  const appFrontmatter: Record<string, unknown> = {
    schema: "app/v1",
    ...(app.id !== undefined ? { id: app.id } : {}),
    ...(app.name !== undefined ? { name: app.name } : {}),
    version: app.version ?? "0.1.0",
    ...(app.description !== undefined ? { description: app.description } : {}),
    agents: agentRefs,
    workflows: workflowRefs,
    ...(app.workspace ? { workspace: app.workspace.id } : {}),
    ...(app.requires !== undefined ? { requires: app.requires } : {}),
  }
  await writeFile(appPath, toManifest(appFrontmatter, app.description ?? ""), "utf8")

  return { agentPaths, workflowPaths, appPath, ...(workspacePath ? { workspacePath } : {}) }
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
