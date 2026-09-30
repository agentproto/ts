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
 * The app may also ship AIP-14 TOOL.md / AIP-30 DRIVER.md bundles under
 * `.agentproto/tools/<id>/TOOL.md` and `.agentproto/drivers/<id>/DRIVER.md`
 * — discovered by directory convention (see `loadAppBundledTools`), not
 * declared as APP.md frontmatter refs like agents/workflows are.
 *
 * Frontmatter validation here is deliberately minimal, and that is now an
 * AIP-53 conformance decision, not an accident of app having "no AIP yet":
 * AIP-53 (Draft) freezes the loader contract at the checks below — schema
 * MUST be exactly `app/v1`, `agents`/`workflows` MUST be `{ id, path }`
 * ref arrays, every ref MUST resolve, and the bundle MUST re-run through
 * `defineApp` — and it does NOT require rejecting unknown frontmatter
 * keys. Staying permissive past the frozen checks lets a future frontmatter
 * key (e.g. a later WP's addition) round-trip through this loader without
 * hosts that haven't upgraded rejecting the whole app; tightening beyond
 * the spec would break that forward compatibility for no conformance gain.
 */

import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import matter from "gray-matter"
import { agentFromManifest, parseAgentManifest } from "@agentproto/agent/manifest"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { parseWorkspaceManifest, workspaceFromManifest } from "@agentproto/workspace/manifest"
import type {
  AgentEntry,
  AppArtifactDecl,
  AppBoundariesDefinition,
  AppDataDefinition,
  AppDefinition,
  AppDevDefinition,
  AppHandle,
  AppUiBuildConfig,
  OpenAIAppUiExtension,
} from "./types.js"
import { defineApp } from "./define-app.js"
import { AppLoadError } from "./errors.js"
import { loadAppBundledTools } from "./load-app-tools.js"
import { normalizeManifestFields } from "./manifest-fields.js"

export { AppLoadError }

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
    readonly frameDomains?: readonly string[]
  }
  readonly build?: AppUiBuildConfig
  /** Namespaced vendor extension metadata; `openai` is the only namespace
   *  (validated by `defineApp`, which this loader re-runs through). */
  readonly extensions?: { readonly openai?: unknown }
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
  readonly requires?: AppDefinition["requires"]
  readonly placement?: AppDefinition["placement"]
  readonly exposes?: AppDefinition["exposes"]
  readonly accepts?: AppDefinition["accepts"]
  readonly ui?: AppFrontmatterUi
  readonly artifact?: AppFrontmatterArtifact
  readonly skill?: AppFrontmatterSkill
  readonly artifacts?: readonly AppArtifactDecl[]
  readonly dev?: AppDevDefinition
  readonly data?: AppDataDefinition
  readonly externalReadRoots?: readonly string[]
  readonly boundaries?: AppBoundariesDefinition
  readonly category?: string
}

function resolveRef(dir: string, path: string): string {
  return isAbsolute(path) ? path : join(dir, path)
}

/**
 * Resolve the UI ROOT directory an app's UI should be served from — the
 * same resolution `app_install`/`loadAppHandle` uses for `ui.path`, so
 * `app serve` and install agree on where the UI lives.
 *
 * Reads `<appDir>/.agentproto/APP.md` frontmatter: when a `ui.path` is
 * declared, the UI root is the directory CONTAINING that entry file (e.g.
 * `ui.path: ui/index.html` → `<appDir>/ui`); when `ui` is absent, returns
 * `undefined` and callers fall back to the legacy `<appDir>/.agentproto/ui/`.
 * Throws {@link AppLoadError} on a `ui` that isn't an object or whose `path`
 * isn't a non-empty string — the same shape `loadAppHandle` would reject.
 * Returns `undefined` (not a throw) when APP.md itself is unreadable, since
 * callers check APP.md existence separately.
 */
export async function resolveAppUIRoot(appDir: string): Promise<string | undefined> {
  const appMdPath = join(appDir, ".agentproto", "APP.md")
  let source: string
  try {
    source = await readFile(appMdPath, "utf8")
  } catch {
    return undefined
  }
  const data = matter(source).data as Record<string, unknown>
  const ui = data.ui
  if (ui === undefined) return undefined
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) {
    throw new AppLoadError(`'${appMdPath}': frontmatter 'ui' must be an object.`)
  }
  const path = (ui as Record<string, unknown>).path
  if (typeof path !== "string" || path.trim() === "") {
    throw new AppLoadError(
      `'${appMdPath}': frontmatter 'ui.path' must be a non-empty string.`,
    )
  }
  return dirname(resolveRef(appDir, path))
}

/** Validated `ui.path` + `ui.build`, as returned by {@link peekAppUi}. */
export interface AppUiPeek {
  readonly path: string
  readonly build?: AppUiBuildConfig
}

function parseUiBuildFrontmatter(raw: unknown, appMdPath: string): AppUiBuildConfig | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AppLoadError(`'${appMdPath}': frontmatter 'ui.build' must be an object.`)
  }
  const command = (raw as Record<string, unknown>).command
  if (typeof command !== "string" || command.trim() === "") {
    throw new AppLoadError(`'${appMdPath}': frontmatter 'ui.build.command' must be a non-empty string.`)
  }
  const cwd = (raw as Record<string, unknown>).cwd
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim() === "")) {
    throw new AppLoadError(`'${appMdPath}': frontmatter 'ui.build.cwd' must be a non-empty string.`)
  }
  const sources = (raw as Record<string, unknown>).sources
  if (
    sources !== undefined &&
    (!Array.isArray(sources) || !sources.every(s => typeof s === "string" && s.trim() !== ""))
  ) {
    throw new AppLoadError(
      `'${appMdPath}': frontmatter 'ui.build.sources' must be an array of non-empty strings.`,
    )
  }
  return {
    command,
    ...(cwd !== undefined ? { cwd: cwd as string } : {}),
    ...(sources !== undefined ? { sources: sources as string[] } : {}),
  }
}

/**
 * Peek `<appDir>/.agentproto/APP.md`'s `ui.path` + `ui.build` WITHOUT
 * reading the ui html itself.
 *
 * `loadAppHandle` reads `ui.path` eagerly and throws {@link AppLoadError}
 * when it's missing — exactly the case a declared `ui.build` exists to
 * recover from. A caller that wants to build the bundle before it's
 * expected to exist (the daemon's `app_install`, `app serve`, first UI
 * serve — see `@agentproto/runtime`'s `ensureAppUiBuilt`) resolves this
 * first, runs the build if declared, then calls `loadAppHandle` as usual.
 *
 * Returns `undefined` when APP.md is unreadable or declares no `ui` block
 * — same "caller checks existence separately" contract as
 * `resolveAppUIRoot`. Throws on a malformed `ui`/`ui.build` shape, same
 * validation `loadAppHandle` would eventually hit.
 */
export async function peekAppUi(appDir: string): Promise<AppUiPeek | undefined> {
  const appMdPath = join(appDir, ".agentproto", "APP.md")
  let source: string
  try {
    source = await readFile(appMdPath, "utf8")
  } catch {
    return undefined
  }
  const data = matter(source).data as Record<string, unknown>
  const ui = data.ui
  if (ui === undefined) return undefined
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) {
    throw new AppLoadError(`'${appMdPath}': frontmatter 'ui' must be an object.`)
  }
  const path = (ui as Record<string, unknown>).path
  if (typeof path !== "string" || path.trim() === "") {
    throw new AppLoadError(
      `'${appMdPath}': frontmatter 'ui.path' must be a non-empty string.`,
    )
  }
  const build = parseUiBuildFrontmatter((ui as Record<string, unknown>).build, appMdPath)
  return { path: resolveRef(appDir, path), ...(build ? { build } : {}) }
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
  // placement / requires / exposes / accepts: shape, enum and "exposed id is
  // declared" checks, same rules `defineApp` re-applies.
  normalizeManifestFields(
    data,
    { agents: data.agents.map(a => a.id), workflows: data.workflows.map(w => w.id) },
    msg => new AppLoadError(`'${appPath}': frontmatter ${msg}`),
  )
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
  if (data.boundaries !== undefined) {
    const b = data.boundaries as { enforce?: unknown } | null
    if (
      typeof b !== "object" ||
      b === null ||
      Array.isArray(b) ||
      (b.enforce !== undefined && b.enforce !== "required" && b.enforce !== "best-effort")
    ) {
      throw new AppLoadError(
        `'${appPath}': frontmatter 'boundaries' must be an object whose optional 'enforce' is "required" or "best-effort".`,
      )
    }
  }
  if (data.category !== undefined && (typeof data.category !== "string" || data.category.trim() === "")) {
    throw new AppLoadError(`'${appPath}': frontmatter 'category' must be a non-empty string.`)
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

  // AIP-14/AIP-30 tool + driver bundles — not enumerated in APP.md
  // frontmatter like agents/workflows are; discovered by convention under
  // `.agentproto/tools/<id>/TOOL.md` and `.agentproto/drivers/<id>/DRIVER.md`.
  // No declared bundle location exists yet in AIP-53/14/30 (spec gap) — see
  // `loadAppBundledTools` for the loader and its error-handling contract
  // (a parse/read failure fails the whole app load, naming the file path;
  // an absent `tools`/`drivers` directory is not an error).
  const { tools, drivers } = await loadAppBundledTools(dir)

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
    const build = parseUiBuildFrontmatter(fm.ui.build, appPath)
    ui = {
      html,
      ...(fm.ui.title !== undefined ? { title: fm.ui.title } : {}),
      ...(fm.ui.description !== undefined ? { description: fm.ui.description } : {}),
      ...(fm.ui.tools !== undefined ? { tools: fm.ui.tools } : {}),
      ...(fm.ui.port !== undefined ? { port: fm.ui.port } : {}),
      ...(fm.ui.csp !== undefined ? { csp: fm.ui.csp } : {}),
      ...(build !== undefined ? { build } : {}),
      ...(fm.ui.extensions !== undefined
        ? {
            extensions: {
              ...(fm.ui.extensions.openai !== undefined
                ? { openai: fm.ui.extensions.openai as unknown as OpenAIAppUiExtension }
                : {}),
            },
          }
        : {}),
    }
  }

  return defineApp({
    agents,
    workflows,
    tools,
    drivers,
    ...(workspace ? { workspace } : {}),
    ...(fm.id !== undefined ? { id: fm.id } : {}),
    ...(fm.name !== undefined ? { name: fm.name } : {}),
    ...(fm.version !== undefined ? { version: fm.version } : {}),
    ...(fm.description !== undefined ? { description: fm.description } : {}),
    ...(fm.requires !== undefined ? { requires: fm.requires } : {}),
    ...(fm.placement !== undefined ? { placement: fm.placement } : {}),
    ...(fm.exposes !== undefined ? { exposes: fm.exposes } : {}),
    ...(fm.accepts !== undefined ? { accepts: fm.accepts } : {}),
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
    ...(fm.boundaries !== undefined ? { boundaries: fm.boundaries } : {}),
    ...(fm.category !== undefined ? { category: fm.category } : {}),
  })
}
