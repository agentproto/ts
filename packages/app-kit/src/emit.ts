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

import { copyFile, cp, mkdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import matter from "gray-matter"
import type { WorkflowHandle } from "@agentproto/workflow"
import type { WorkspaceHandle } from "@agentproto/workspace"
import type { AgentEntry, AppArtifactDecl, AppArtifactSurface, AppDevDefinition, AppSkillSurface, AppUiDefinition, EmittedApp } from "./types.js"
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
  readonly ui?: AppUiDefinition
  readonly artifact?: AppArtifactSurface
  readonly skill?: AppSkillSurface
  readonly artifacts?: readonly AppArtifactDecl[]
  readonly dev?: AppDevDefinition
}

export async function emitApp(app: EmitInput, dir: string): Promise<EmittedApp> {
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

  let uiPath: string | undefined
  let uiFrontmatter: Record<string, unknown> | undefined
  if (app.ui) {
    const uiDir = join(dir, ".agentproto", "ui")
    await mkdir(uiDir, { recursive: true })
    uiPath = join(uiDir, "index.html")
    await writeFile(uiPath, app.ui.html, "utf8")
    uiFrontmatter = {
      path: relative(dir, uiPath),
      ...(app.ui.title !== undefined ? { title: app.ui.title } : {}),
      ...(app.ui.description !== undefined ? { description: app.ui.description } : {}),
      ...(app.ui.tools !== undefined ? { tools: app.ui.tools } : {}),
      ...(app.ui.port !== undefined ? { port: app.ui.port } : {}),
      ...(app.ui.csp !== undefined ? { csp: app.ui.csp } : {}),
    }
  }

  let artifactPath: string | undefined
  let artifactFrontmatter: Record<string, unknown> | undefined
  if (app.artifact) {
    const artifactDir = join(dir, ".agentproto", "artifact")
    await mkdir(artifactDir, { recursive: true })
    artifactPath = join(artifactDir, "index.html")
    await copyFile(app.artifact.path, artifactPath)
    artifactFrontmatter = {
      path: relative(dir, artifactPath),
      ...(app.artifact.title !== undefined ? { title: app.artifact.title } : {}),
      ...(app.artifact.description !== undefined ? { description: app.artifact.description } : {}),
    }
  }

  let skillPath: string | undefined
  let skillFrontmatter: Record<string, unknown> | undefined
  if (app.skill) {
    skillPath = join(dir, ".agentproto", "skill")
    await mkdir(skillPath, { recursive: true })
    await cp(app.skill.path, skillPath, { recursive: true })
    skillFrontmatter = {
      path: relative(dir, skillPath),
      ...(app.skill.title !== undefined ? { title: app.skill.title } : {}),
      ...(app.skill.description !== undefined ? { description: app.skill.description } : {}),
    }
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
    ...(uiFrontmatter !== undefined ? { ui: uiFrontmatter } : {}),
    ...(artifactFrontmatter !== undefined ? { artifact: artifactFrontmatter } : {}),
    ...(skillFrontmatter !== undefined ? { skill: skillFrontmatter } : {}),
    ...(app.artifacts !== undefined ? { artifacts: app.artifacts } : {}),
    ...(app.dev !== undefined ? { dev: app.dev } : {}),
  }
  await writeFile(appPath, toManifest(appFrontmatter, app.description ?? ""), "utf8")

  return {
    agentPaths,
    workflowPaths,
    appPath,
    ...(workspacePath ? { workspacePath } : {}),
    ...(uiPath ? { uiPath } : {}),
    ...(artifactPath ? { artifactPath } : {}),
    ...(skillPath ? { skillPath } : {}),
  }
}

function toManifest(handle: object, body: string): string {
  const data: Record<string, unknown> = JSON.parse(JSON.stringify(handle))
  return matter.stringify(`\n${body}\n`, data)
}
