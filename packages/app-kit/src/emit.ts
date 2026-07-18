/**
 * `emitApp(app, dir)` — write an app's agent + workflows to disk in the
 * layout the daemon and the `agentproto-run` CI lane load:
 *
 *   <dir>/.agents/<id>/AGENT.md
 *   <dir>/.agents/<id>/workflows/<wf.id>/WORKFLOW.md
 *
 * Both are plain markdown manifests: frontmatter = the validated handle,
 * body = the system prompt (AGENT.md) or the workflow description. Because
 * a `defineWorkflow` handle is pure data, the WORKFLOW.md needs no `entry:`
 * module — the manifest *is* the workflow, so `loadWorkflowHandle` returns
 * it directly with nothing to reconcile against.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import matter from "gray-matter"
import type { AgentHandle } from "@agentproto/agent"
import type { WorkflowHandle } from "@agentproto/workflow"
import type { EmittedApp } from "./types.js"
import { stripOwner } from "./refs.js"

interface EmitInput {
  readonly agent: AgentHandle
  readonly systemPrompt: string
  readonly workflows: readonly WorkflowHandle[]
}

export async function emitApp(app: EmitInput, dir: string): Promise<EmittedApp> {
  const agentDir = join(dir, ".agents", stripOwner(app.agent.id))
  await mkdir(agentDir, { recursive: true })

  const agentPath = join(agentDir, "AGENT.md")
  await writeFile(agentPath, toManifest(app.agent, app.systemPrompt), "utf8")

  const workflowPaths: string[] = []
  for (const wf of app.workflows) {
    const wfDir = join(agentDir, "workflows", wf.id)
    await mkdir(wfDir, { recursive: true })
    const wfPath = join(wfDir, "WORKFLOW.md")
    await writeFile(wfPath, toManifest(wf, wf.description ?? ""), "utf8")
    workflowPaths.push(wfPath)
  }

  return { agentPath, workflowPaths }
}

/**
 * Serialize a handle to a `.md` manifest. gray-matter's YAML engine
 * rejects `undefined` values, so drop absent optional fields first; the
 * handle is otherwise a plain data object that round-trips through the
 * matching `parse*Manifest`.
 */
function toManifest(handle: object, body: string): string {
  const data = stripUndefined(handle)
  // gray-matter appends a trailing newline to the body; keep manifests
  // ending in exactly one newline.
  return matter.stringify(`\n${body}\n`, data)
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as unknown as T
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      out[k] = stripUndefined(v)
    }
    return out as T
  }
  return value
}
