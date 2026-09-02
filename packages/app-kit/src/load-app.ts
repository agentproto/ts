/**
 * `loadAppHandle(dir)` — read a root `APP.md` off disk into an `AppHandle`.
 *
 * Mirror of `@agentproto/workflow-loader`'s `loadWorkflowHandle`: this is
 * the host-side seam that touches the filesystem so the pure packages
 * (`@agentproto/agent`, `@agentproto/workflow`, `@agentproto/workspace`)
 * don't have to.
 *
 * `<dir>/.agentproto/APP.md` lists every agent + workflow the app bundles
 * as `{ id, path }` refs (relative to `dir`, the shape `emitApp` writes).
 * Each is loaded with its own package's manifest reader — `AGENT.md` via
 * `@agentproto/agent/manifest`, `WORKFLOW.md` via
 * `@agentproto/workflow-loader` (which itself resolves an `entry:` module
 * when present) — then the whole bundle is re-run through `defineApp` so
 * the attachment invariant (every agent/workflow ref resolves both ways)
 * re-validates exactly as it did at authoring time. A stale or hand-edited
 * APP.md that drifted from its AGENT.md/WORKFLOW.md refs fails the same
 * way a bad `defineApp({...})` call would.
 *
 * The frontmatter shape intentionally has no generated zod schema (unlike
 * AGENT.md/WORKFLOW.md, there's no AIP number for "app" yet) and validation
 * here stays loose on purpose — a future key (e.g. WP-B3's `requires.tools`)
 * should round-trip without this loader rejecting it.
 */

import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import matter from "gray-matter"
import { agentFromManifest, parseAgentManifest } from "@agentproto/agent/manifest"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { parseWorkspaceManifest, workspaceFromManifest } from "@agentproto/workspace/manifest"
import type { AgentEntry, AppArtifactDecl, AppDataDefinition, AppDevDefinition, AppHandle, AppLibraryDefinition } from "./types.js"
import { defineApp } from "./define-app.js"

export class AppLoadError extends Error {
  constructor(message: string) {
    super(`loadAppHandle: ${message}`)
    this.name = "AppLoadError"
  }
}

interface AppRef {
  readonly id: string
  readonly path: string
}

interface AppFrontmatterUi {
  readonly path: string
  readonly title?: string
  readonly description?: string
  readonly tools?: readonly string[]
  readonly port?: number
  readonly csp?: {
    readonly connectDomains?: readonly string[]
    readonly resourceDomains?: readonly string[]
  }
}

interface AppFrontmatterArtifact {
  readonly path: string
  readonly title?: string
  readonly description?: string
}

interface AppFrontmatterSkill {
  readonly path: string
  readonly title?: string
  readonly description?: string
}

interface AppFrontmatter {
  readonly schema: string
  readonly id?: string
  readonly name?: string
  readonly version?: string
  readonly description?: string
  readonly agents: readonly AppRef[]
  readonly workflows: readonly AppRef[]
  readonly workspace?: string
  readonly requires?: readonly string[]
  readonly ui?: AppFrontmatterUi
  readonly artifact?: AppFrontmatterArtifact
  readonly skill?: AppFrontmatterSkill
  readonly artifacts?: readonly AppArtifactDecl[]
  readonly dev?: AppDevDefinition
  readonly data?: AppDataDefinition
  readonly externalReadRoots?: readonly string[]
  readonly category?: string
  readonly library?: AppLibraryDefinition
}

function resolveRef(dir: string, path: string): string {
  return isAbsolute(path) ? path : join(dir, path)
}

function isRefArray(v: unknown): v is AppRef[] {
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as { id?: unknown }).id === "string" &&
        typeof (e as { path?: unknown }).path === "string",
    )
  )
}

function isLibrary(v: unknown): v is AppLibraryDefinition {
  if (typeof v !== "object" || v === null) return false
  const books = (v as { books?: unknown }).books
  if (!Array.isArray(books) || books.length === 0) return false
  return books.every(
    (b) =>
      typeof b === "object" &&
      b !== null &&
      typeof (b as { id?: unknown }).id === "string" &&
      (b as { id: string }).id.trim() !== "",
  )
}

/** Minimal shape check — see the module doc for why this stays loose. */
function parseAppFrontmatter(data: Record<string, unknown>, appPath: string): AppFrontmatter {
  if (data.schema !== "app/v1") {
    throw new AppLoadError(
      `'${appPath}': expected frontmatter 'schema: app/v1', got ${JSON.stringify(data.schema)}.`,
    )
  }
  if (!isRefArray(data.agents)) {
    throw new AppLoadError(`'${appPath}': frontmatter 'agents' must be an array of { id, path }.`)
  }
  if (!isRefArray(data.workflows)) {
    throw new AppLoadError(
      `'${appPath}': frontmatter 'workflows' must be an array of { id, path }.`,
    )
  }
  if (data.requires !== undefined) {
    if (!Array.isArray(data.requires) || !data.requires.every((e) => typeof e === "string")) {
      throw new AppLoadError(`'${appPath}': frontmatter 'requires' must be an array of strings.`)
    }
  }
  if (data.data !== undefined) {
    const d = data.data as { dir?: unknown } | null
    if (
      typeof d !== "object" ||
      d === null ||
      (d.dir !== undefined && (typeof d.dir !== "string" || d.dir.trim() === ""))
    ) {
      throw new AppLoadError(
        `'${appPath}': frontmatter 'data' must be an object whose optional 'dir' is a non-empty string.`,
      )
    }
  }
  if (data.externalReadRoots !== undefined) {
    if (
      !Array.isArray(data.externalReadRoots) ||
      !data.externalReadRoots.every((e) => typeof e === "string" && e.trim() !== "")
    ) {
      throw new AppLoadError(
        `'${appPath}': frontmatter 'externalReadRoots' must be an array of non-empty strings.`,
      )
    }
  }
  if (data.category !== undefined && (typeof data.category !== "string" || data.category.trim() === "")) {
    throw new AppLoadError(`'${appPath}': frontmatter 'category' must be a non-empty string.`)
  }
  if (data.library !== undefined && !isLibrary(data.library)) {
    throw new AppLoadError(
      `'${appPath}': frontmatter 'library' must be an object with a non-empty 'books' array of { id, title?, progress? }.`,
    )
  }
  return data as unknown as AppFrontmatter
}

async function loadAgentEntry(dir: string, ref: AppRef): Promise<AgentEntry> {
  const agentPath = resolveRef(dir, ref.path)
  let source: string
  try {
    source = await readFile(agentPath, "utf8")
  } catch (err) {
    throw new AppLoadError(
      `agent '${ref.id}': cannot read '${agentPath}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  let body: string
  let manifest: ReturnType<typeof parseAgentManifest>
  try {
    manifest = parseAgentManifest(source)
    body = manifest.body.trim()
  } catch (err) {
    throw new AppLoadError(
      `agent '${ref.id}' at '${agentPath}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return { agent: agentFromManifest(manifest), ...(body ? { body } : {}) }
}

async function loadWorkflowRef(dir: string, ref: AppRef) {
  const wfPath = resolveRef(dir, ref.path)
  try {
    return await loadWorkflowHandle(wfPath)
  } catch (err) {
    throw new AppLoadError(
      `workflow '${ref.id}' at '${wfPath}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Load `<dir>/.agentproto/APP.md` and every AGENT.md/WORKFLOW.md (and, if
 * declared, `<dir>/WORKSPACE.md`) it references, then re-run `defineApp` on
 * the result. Throws {@link AppLoadError} naming the offending path on a
 * missing APP.md, a missing referenced file, or a frontmatter/schema
 * mismatch; throws `AppDefinitionError` (from `defineApp`) if the loaded
 * bundle fails the attachment invariant.
 */
export async function loadAppHandle(dir: string): Promise<AppHandle> {
  const appPath = join(dir, ".agentproto", "APP.md")
  let source: string
  try {
    source = await readFile(appPath, "utf8")
  } catch (err) {
    throw new AppLoadError(
      `cannot read '${appPath}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const parsed = matter(source)
  const fm = parseAppFrontmatter(parsed.data, appPath)

  const agents: AgentEntry[] = []
  for (const ref of fm.agents) {
    agents.push(await loadAgentEntry(dir, ref))
  }

  const workflows = []
  for (const ref of fm.workflows) {
    workflows.push(await loadWorkflowRef(dir, ref))
  }

  let workspace
  if (fm.workspace) {
    const workspacePath = join(dir, "WORKSPACE.md")
    let workspaceSource: string
    try {
      workspaceSource = await readFile(workspacePath, "utf8")
    } catch (err) {
      throw new AppLoadError(
        `workspace '${fm.workspace}': cannot read '${workspacePath}': ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    try {
      workspace = workspaceFromManifest(parseWorkspaceManifest(workspaceSource))
    } catch (err) {
      throw new AppLoadError(
        `workspace '${fm.workspace}' at '${workspacePath}': ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  let ui
  if (fm.ui) {
    const uiPath = resolveRef(dir, fm.ui.path)
    let html: string
    try {
      html = await readFile(uiPath, "utf8")
    } catch (err) {
      throw new AppLoadError(
        `ui: cannot read '${uiPath}': ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    ui = {
      html,
      ...(fm.ui.title !== undefined ? { title: fm.ui.title } : {}),
      ...(fm.ui.description !== undefined ? { description: fm.ui.description } : {}),
      ...(fm.ui.tools !== undefined ? { tools: fm.ui.tools } : {}),
      ...(fm.ui.port !== undefined ? { port: fm.ui.port } : {}),
      ...(fm.ui.csp !== undefined ? { csp: fm.ui.csp } : {}),
    }
  }

  return defineApp({
    agents,
    workflows,
    ...(workspace ? { workspace } : {}),
    ...(fm.id !== undefined ? { id: fm.id } : {}),
    ...(fm.name !== undefined ? { name: fm.name } : {}),
    ...(fm.version !== undefined ? { version: fm.version } : {}),
    ...(fm.description !== undefined ? { description: fm.description } : {}),
    ...(fm.requires !== undefined ? { requires: fm.requires } : {}),
    ...(ui !== undefined ? { ui } : {}),
    ...(fm.artifact !== undefined
      ? { artifact: { path: resolveRef(dir, fm.artifact.path), ...(fm.artifact.title !== undefined ? { title: fm.artifact.title } : {}), ...(fm.artifact.description !== undefined ? { description: fm.artifact.description } : {}) } }
      : {}),
    ...(fm.skill !== undefined
      ? { skill: { path: resolveRef(dir, fm.skill.path), ...(fm.skill.title !== undefined ? { title: fm.skill.title } : {}), ...(fm.skill.description !== undefined ? { description: fm.skill.description } : {}) } }
      : {}),
    ...(fm.artifacts !== undefined ? { artifacts: fm.artifacts } : {}),
    ...(fm.dev !== undefined ? { dev: fm.dev } : {}),
    ...(fm.data !== undefined ? { data: fm.data } : {}),
    ...(fm.externalReadRoots !== undefined ? { externalReadRoots: fm.externalReadRoots } : {}),
    ...(fm.category !== undefined ? { category: fm.category } : {}),
    ...(fm.library !== undefined ? { library: fm.library } : {}),
  })
}
