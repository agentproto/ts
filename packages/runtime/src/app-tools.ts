/**
 * MCP tools that install and run `@agentproto/app-kit` apps — a bundle of
 * one or more AIP-42 agents plus the AIP-15 workflows they run, emitted
 * under `<dir>/.agentproto/` by `defineApp().emit(dir)`.
 *
 * Tools:
 *   app_install   loadAppHandle(dir) → validate → persist an installed-app record
 *   app_list      installed apps + a runs summary
 *   app_run       spawn a session per selected agent (mastra-agent adapter)
 *   app_status    fan out an app_run's sessions + the app's workflow runs
 *   app_stop      kill an app_run's sessions
 *
 * `app_install` moves workflow-step tool-id validation from STEP-DISPATCH
 * time (where it used to surface, deep into a run — see
 * `output/phase-a-findings.md` A2: `unknown daemon tool "apply_patch"`) to
 * install time, listing every missing id at once instead of failing one
 * step at a time.
 */

import { readFile, readdir, stat } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import matter from "gray-matter"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { loadAppHandle } from "@agentproto/app-kit"
import type { AnyRef } from "@agentproto/agent"
import type { AgentRefResolution } from "@agentproto/workflow-runtime"
import { createDaemonToolRegistry } from "./workflow-tool-registry.js"
import { spawnAgentSession } from "./session-spawn.js"
import type { SessionsRegistry } from "./sessions.js"
import type { AgentAdapterResolver } from "./http-server.js"
import type { WorkflowRunner } from "./workflow-runner.js"
import { createAppRegistry, type AppRegistry, type InstalledAppRef } from "./app-registry.js"
import { loadAppCatalogFile } from "./app-catalog.js"

/** The only agent adapter this WP knows how to run an emitted AGENT.md
 *  under — see `adapters/mastra-agent`'s `agent` option (`--agent <path>`). */
export const DEFAULT_AGENT_ADAPTER = "mastra-agent"

/**
 * Build `compileWorkflow`'s `agentRefs` map for a workflow bundled by an
 * installed app — every agent id the app bundles resolves to a spawn under
 * `mastra-agent`, pointed at that agent's emitted AGENT.md (WP-B4). Returns
 * undefined when no installed app bundles `workflowId` (a plain
 * `workflow_run_file` outside any app), so a `kind:"agent"` step using
 * `agent.ref` fails compilation naming "no agent refs are configured"
 * rather than a silently-empty map producing the same message either way.
 */
export function resolveAgentRefsForWorkflow(
  appRegistry: AppRegistry,
  workflowId: string,
): Record<string, AgentRefResolution> | undefined {
  const app = appRegistry.listApps().find(a => a.workflows.some(w => w.id === workflowId))
  if (!app) return undefined
  const refs: Record<string, AgentRefResolution> = {}
  for (const agent of app.agents) {
    refs[agent.id] = { adapter: DEFAULT_AGENT_ADAPTER, options: { agent: agent.path } }
  }
  return refs
}

function textResult(body: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] }
}

function errorResult(text: string): {
  content: { type: "text"; text: string }[]
  isError: true
} {
  return { content: [{ type: "text", text: JSON.stringify({ error: text }) }], isError: true }
}

function notEnabled(tool: string): ReturnType<typeof errorResult> {
  return errorResult(
    `${tool} is not enabled — the daemon was started without an adapter resolver. ` +
      "Re-run the daemon with the `@agentproto/cli` shim wired (see playground/scripts/gateway.ts).",
  )
}

export interface AppToolCallDeps {
  dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
  callImportedTool?: (alias: string, tool: string, args: Record<string, unknown>) => Promise<unknown>
}

/**
 * The `app_tool_call` gateway's whole behaviour — allowlist enforcement
 * against the installed app's `ui.tools`, then dispatch through the daemon's
 * own tools or an imported MCP server — shared verbatim between the MCP verb
 * below and the HTTP twin (`POST /apps/:appId/tool-call`, http-server.ts) so
 * the two surfaces can never drift. Returns the MCP result envelope both
 * callers hand back untouched.
 */
export async function performAppToolCall(
  appRegistry: AppRegistry,
  input: { appId: string; tool: string; args?: Record<string, unknown> },
  deps: AppToolCallDeps,
): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  const installed = appRegistry.getApp(input.appId)
  if (!installed || !installed.ui) {
    return errorResult(`app_tool_call: app "${input.appId}" is not installed or has no UI.`)
  }
  const allowlist = installed.ui.tools ?? []
  if (!allowlist.includes(input.tool)) {
    return errorResult(
      `app_tool_call: tool "${input.tool}" is not in app "${input.appId}"'s ui.tools allowlist: ` +
        `${allowlist.length > 0 ? allowlist.join(", ") : "(empty)"}`,
    )
  }

  const args = input.args ?? {}
  try {
    if (input.tool.startsWith("imported:")) {
      if (!deps.callImportedTool) return notEnabled("app_tool_call")
      const rest = input.tool.slice("imported:".length)
      const slash = rest.indexOf("/")
      if (slash === -1) {
        return errorResult(
          `app_tool_call: malformed imported tool id "${input.tool}" — expected "imported:<alias>/<toolName>".`,
        )
      }
      const result = await deps.callImportedTool(rest.slice(0, slash), rest.slice(slash + 1), args)
      return textResult(result)
    }
    if (!deps.dispatchTool) return notEnabled("app_tool_call")
    const result = await deps.dispatchTool(input.tool, args)
    return textResult(result)
  } catch (err) {
    return errorResult(`app_tool_call: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function refIdOf(ref: AnyRef): string {
  if (typeof ref === "string") return ref
  return ref.ref ?? ref.file ?? "inline"
}

function resolveRef(dir: string, path: string): string {
  return isAbsolute(path) ? path : join(dir, path)
}

/**
 * `loadAppHandle`'s returned `AppHandle` carries parsed agent/workflow
 * handles but NOT the on-disk paths it read them from (they're discarded
 * inside the loader's own closures) — re-read the frontmatter's raw
 * `{ id, path }` refs directly. Only called after `loadAppHandle` already
 * validated the file, so this stays a plain best-effort re-parse.
 */
interface AppRefsUi {
  readonly path: string
  readonly title?: string
  readonly description?: string
  readonly tools?: readonly string[]
  readonly csp?: {
    readonly connectDomains?: readonly string[]
    readonly resourceDomains?: readonly string[]
  }
}

interface AppRefsArtifact {
  readonly path: string
  readonly title?: string
  readonly description?: string
}

interface AppRefsSkill {
  readonly path: string
  readonly title?: string
  readonly description?: string
}

async function readAppRefs(
  dir: string,
): Promise<{ agents: InstalledAppRef[]; workflows: InstalledAppRef[]; ui?: AppRefsUi; artifact?: AppRefsArtifact; skill?: AppRefsSkill }> {
  const appPath = join(dir, ".agentproto", "APP.md")
  const source = await readFile(appPath, "utf8")
  const { data } = matter(source) as { data: { agents?: unknown; workflows?: unknown; ui?: unknown; artifact?: unknown; skill?: unknown } }
  const toRefs = (v: unknown): InstalledAppRef[] =>
    Array.isArray(v)
      ? v
          .filter(
            (e): e is { id: string; path: string } =>
              typeof e === "object" &&
              e !== null &&
              typeof (e as { id?: unknown }).id === "string" &&
              typeof (e as { path?: unknown }).path === "string",
          )
          .map(e => ({ id: e.id, path: resolveRef(dir, e.path) }))
      : []
  let ui: AppRefsUi | undefined
  if (typeof data.ui === "object" && data.ui !== null && typeof (data.ui as { path?: unknown }).path === "string") {
    const uiData = data.ui as AppRefsUi
    ui = { ...uiData, path: resolveRef(dir, uiData.path) }
  }
  let artifact: AppRefsArtifact | undefined
  if (typeof data.artifact === "object" && data.artifact !== null && typeof (data.artifact as { path?: unknown }).path === "string") {
    const artData = data.artifact as AppRefsArtifact
    artifact = { ...artData, path: resolveRef(dir, artData.path) }
  }
  let skill: AppRefsSkill | undefined
  if (typeof data.skill === "object" && data.skill !== null && typeof (data.skill as { path?: unknown }).path === "string") {
    const skillData = data.skill as AppRefsSkill
    skill = { ...skillData, path: resolveRef(dir, skillData.path) }
  }
  return { agents: toRefs(data.agents), workflows: toRefs(data.workflows), ...(ui ? { ui } : {}), ...(artifact ? { artifact } : {}), ...(skill ? { skill } : {}) }
}

export interface RegisterAppToolsOptions {
  registry: SessionsRegistry
  /** Required for `app_install`'s adapter-resolves check and `app_run`'s
   *  spawn. Omitted → both return a clear "not enabled" error, mirroring
   *  `agent_start`. */
  resolveAgentAdapter?: AgentAdapterResolver
  /**
   * Every daemon tool id currently dispatchable in-process (the internal
   * McpServer's `_registeredTools` keys — same reach-in `dispatchTool`
   * uses). `app_install` cross-checks every WORKFLOW.md `tool` step's id
   * against this set, listing every unknown one at once instead of
   * failing one step at a time deep into a run.
   */
  listRegisteredToolIds: () => Promise<string[]>
  /** When wired, `app_status` folds in workflow runs whose `workflowId`
   *  belongs to the app — any run of one of its bundled WORKFLOW.md files,
   *  however it was started (`workflow_run_file`, `workflow_start`, …).
   *  Omitted → `app_status` reports sessions only. */
  workflowRunner?: WorkflowRunner
  /** Absolute path for the persistence file. Defaults to `~/.agentproto/apps.json`. */
  persistPath?: string
  /** Enable filesystem persistence. Defaults to `true` when `persistPath` is
   *  explicitly supplied, `false` otherwise — mirrors workflow-runner.ts. */
  persist?: boolean
  /** Share an already-built `AppRegistry` instead of creating a private one
   *  — the host wires the same instance into `WorkflowRunner`'s
   *  `compileWorkflow` closure so `resolveAgentRefsForWorkflow` sees every
   *  installed app (see `@agentproto/runtime`'s daemon composition root).
   *  Omitted ⇒ creates its own (this module's prior behaviour). */
  appRegistry?: AppRegistry
  /** Dispatch a daemon tool call by name — same in-process caller
   *  `dispatchTool` in index.ts wires to routines/cron. Backs `app_tool_call`
   *  for every tool id NOT prefixed `imported:`. Omitted → `app_tool_call`
   *  errors "not enabled" for those ids, mirroring `notEnabled` above. */
  dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /** Call a tool on an imported MCP server — backs `app_tool_call` for
   *  `imported:<alias>/<toolName>` ids (see `mcp_imported_call` in
   *  session-tools.ts, same `mcpProxy.callTool` underneath). Omitted →
   *  `app_tool_call` errors "not enabled" for those ids. */
  callImportedTool?: (alias: string, tool: string, args: Record<string, unknown>) => Promise<unknown>
  /** Absolute path to the app catalog JSON file read by `app_catalog`.
   *  Defaults to `~/.agentproto/app-catalog.json`. Missing file → empty
   *  catalog (never an error). */
  catalogPath?: string
}

export async function performInstall(
  dir: string,
  appRegistry: AppRegistry,
  listRegisteredToolIds: () => Promise<string[]>,
  resolveAgentAdapter?: AgentAdapterResolver,
): Promise<{ ok: true; record: Awaited<ReturnType<typeof appRegistry.upsertApp>> } | { ok: false; error: string }> {
  let handle: Awaited<ReturnType<typeof loadAppHandle>>
  try {
    handle = await loadAppHandle(dir)
  } catch (err) {
    return { ok: false, error: `${err instanceof Error ? err.message : String(err)}` }
  }

  if (!handle.id) {
    return { ok: false, error: "the app has no `id` — set one in defineApp()/APP.md frontmatter to install it." }
  }

  const missingByWorkflow: Record<string, string[]> = {}
  const registeredIds = new Set(await listRegisteredToolIds())
  for (const workflow of handle.workflows) {
    const { tools } = createDaemonToolRegistry(workflow, async () => undefined)
    const missing = Object.keys(tools).filter(id => !registeredIds.has(id))
    if (missing.length > 0) missingByWorkflow[workflow.id] = missing
  }
  if (Object.keys(missingByWorkflow).length > 0) {
    return {
      ok: false,
      error: `unknown daemon tool id(s) referenced by workflow step(s) — would otherwise fail at STEP-DISPATCH time: ${JSON.stringify(missingByWorkflow)}`,
    }
  }

  if (handle.agents.length > 0) {
    const resolved = resolveAgentAdapter ? await resolveAgentAdapter(DEFAULT_AGENT_ADAPTER) : null
    if (!resolved) {
      return {
        ok: false,
        error: `agent adapter "${DEFAULT_AGENT_ADAPTER}" could not be resolved — run \`agentproto install ${DEFAULT_AGENT_ADAPTER}\` first.`,
      }
    }
  }

  const refs = await readAppRefs(dir)
  const unvalidatedAgentTools = [
    ...new Set(handle.agents.flatMap(e => (e.agent.tools ?? []).map(refIdOf))),
  ]

  const ui = refs.ui
    ? {
        path: refs.ui.path,
        ...(handle.ui?.title !== undefined ? { title: handle.ui.title } : {}),
        ...(handle.ui?.description !== undefined ? { description: handle.ui.description } : {}),
        ...(handle.ui?.tools !== undefined ? { tools: handle.ui.tools } : {}),
        ...(handle.ui?.csp !== undefined ? { csp: handle.ui.csp } : {}),
      }
    : undefined

  const artifact = refs.artifact
    ? {
        path: refs.artifact.path,
        ...(handle.artifact?.title !== undefined ? { title: handle.artifact.title } : {}),
        ...(handle.artifact?.description !== undefined ? { description: handle.artifact.description } : {}),
      }
    : undefined

  if (refs.skill) {
    const skillMdPath = join(refs.skill.path, "SKILL.md")
    let skillSource: string
    try {
      skillSource = await readFile(skillMdPath, "utf8")
    } catch {
      return { ok: false, error: `app_install: skill directory "${refs.skill.path}" is missing SKILL.md.` }
    }
    const skillFm = matter(skillSource).data as { name?: unknown; description?: unknown }
    if (typeof skillFm.name !== "string" || skillFm.name.trim() === "") {
      return { ok: false, error: `app_install: skill SKILL.md frontmatter must have a non-empty 'name' field.` }
    }
    if (typeof skillFm.description !== "string" || skillFm.description.trim() === "") {
      return { ok: false, error: `app_install: skill SKILL.md frontmatter must have a non-empty 'description' field.` }
    }
  }

  const skill = refs.skill
    ? {
        path: refs.skill.path,
        ...(handle.skill?.title !== undefined ? { title: handle.skill.title } : {}),
        ...(handle.skill?.description !== undefined ? { description: handle.skill.description } : {}),
      }
    : undefined

  const record = appRegistry.upsertApp({
    appId: handle.id,
    dir,
    ...(handle.version ? { version: handle.version } : {}),
    ...(handle.name ? { name: handle.name } : {}),
    ...(handle.description ? { description: handle.description } : {}),
    agents: refs.agents,
    workflows: refs.workflows,
    unvalidatedAgentTools,
    ...(handle.requires ? { requires: handle.requires } : {}),
    ...(ui ? { ui } : {}),
    ...(artifact ? { artifact } : {}),
    ...(skill ? { skill } : {}),
    ...(handle.artifacts ? { artifacts: handle.artifacts } : {}),
    ...(handle.dev ? { dev: handle.dev } : {}),
  })

  return { ok: true, record }
}

export function registerAppTools(server: McpServer, opts: RegisterAppToolsOptions): void {
  const { registry, resolveAgentAdapter, listRegisteredToolIds, workflowRunner, dispatchTool, callImportedTool } =
    opts
  const appRegistry: AppRegistry = opts.appRegistry ?? createAppRegistry({
    ...(opts.persistPath !== undefined ? { persistPath: opts.persistPath } : {}),
    ...(opts.persist !== undefined ? { persist: opts.persist } : {}),
  })

  server.tool(
    "app_install",
    "Install an @agentproto/app-kit app from its emitted directory " +
      "(`<dir>/.agentproto/APP.md` — see `defineApp().emit(dir)`). Validates every " +
      "WORKFLOW.md `tool` step's id against the daemon's dispatchable tools (missing " +
      "ids are reported ALL at once, instead of failing one at a time at " +
      "STEP-DISPATCH time) and checks the `mastra-agent` adapter resolves. Agent-" +
      "declared tool refs (workspace tools like `read_file`) are the adapter's own " +
      "business and are never validated here — see `unvalidatedAgentTools` on the " +
      "result. Re-installing the same appId upserts.",
    { dir: z.string().describe("Absolute path to the app's directory.") },
    async input => {
      const result = await performInstall(input.dir, appRegistry, listRegisteredToolIds, resolveAgentAdapter)
      if (!result.ok) return errorResult(`app_install: ${result.error}`)
      return textResult(result.record)
    },
  )

  server.tool(
    "app_list",
    "List installed apps, each with a summary of its app_run history.",
    {},
    async () => {
      const runs = appRegistry.listRuns()
      const apps = appRegistry.listApps().map(app => ({
        ...app,
        runs: runs
          .filter(r => r.appId === app.appId)
          .map(r => ({
            appRunId: r.appRunId,
            status: r.status,
            startedAt: r.startedAt,
            ...(r.endedAt ? { endedAt: r.endedAt } : {}),
            sessions: r.sessions.length,
          })),
      }))
      return textResult(apps)
    },
  )

  server.tool(
    "app_run",
    "Run an installed app's agents as live sessions — one `agent_start`-equivalent " +
      "spawn per selected agent (adapter `mastra-agent`, pointed at that agent's " +
      "emitted AGENT.md via the adapter's `agent` option), grouped under a fresh " +
      "appRunId. Re-reads the app's directory first, so a stale install record " +
      "(paths moved, a workflow renamed) is refreshed before spawning — the same " +
      "refreshed paths are what make `workflow_run_file` work against this app's " +
      "WORKFLOW.md files. Poll with `app_status`, kill with `app_stop`.",
    {
      appId: z.string(),
      agents: z
        .array(z.string())
        .optional()
        .describe("Agent ids to run. Omit to run every agent the app bundles."),
      prompt: z.string().optional().describe("Prompt to send to each spawned agent session."),
      cwd: z
        .string()
        .optional()
        .describe("Working directory for spawned sessions. Defaults to the app's installed `dir`."),
      scopeId: z
        .string()
        .optional()
        .describe("When passed, refuse to run if the app is not applied to this scope."),
      // follow-up: no sandbox support in this WP — the e2b image doesn't carry
      // the mastra-agent adapter yet (see output/phase-a-findings.md A3). Thread
      // a `sandbox` field through to `spawnAgentSession` here once an image
      // provisions it (or `app_install`/boot does `agentproto install
      // mastra-agent` inside the box).
    },
    async input => {
      if (!resolveAgentAdapter) return notEnabled("app_run")
      const installed = appRegistry.getApp(input.appId)
      if (!installed) {
        return errorResult(`app_run: no installed app "${input.appId}" — call app_install first.`)
      }

      if (input.scopeId) {
        const applied = appRegistry.listApplied(input.scopeId)
        if (!applied.some(m => m.appId === input.appId)) {
          return errorResult(
            `app_run: app "${input.appId}" is not applied to scope "${input.scopeId}". Call app_apply first.`,
          )
        }
      }

      let refs: { agents: InstalledAppRef[]; workflows: InstalledAppRef[] }
      try {
        refs = await readAppRefs(installed.dir)
      } catch (err) {
        return errorResult(
          `app_run: could not re-read "${installed.dir}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      const app = appRegistry.upsertApp({ ...installed, agents: refs.agents, workflows: refs.workflows })

      const selected = input.agents ?? app.agents.map(a => a.id)
      const unknown = selected.filter(id => !app.agents.some(a => a.id === id))
      if (unknown.length > 0) {
        return errorResult(
          `app_run: unknown agent id(s) for app "${input.appId}": ${unknown.join(", ")}`,
        )
      }

      const sessions: { agentId: string; sessionId: string }[] = []
      const errors: { agentId: string; error: string }[] = []
      for (const agentId of selected) {
        const agentPath = app.agents.find(a => a.id === agentId)!.path
        const result = await spawnAgentSession(
          { registry, resolveAgentAdapter },
          {
            adapter: DEFAULT_AGENT_ADAPTER,
            cwd: input.cwd ?? app.dir,
            ...(input.prompt ? { prompt: input.prompt } : {}),
            options: { agent: agentPath },
            label: `app:${app.appId}:${agentId}`,
          },
        )
        if (result.ok) sessions.push({ agentId, sessionId: result.descriptor.id })
        else errors.push({ agentId, error: result.message })
      }

      const run = appRegistry.createRun({ appId: app.appId, sessions })
      return textResult({
        appRunId: run.appRunId,
        sessions,
        ...(errors.length > 0 ? { errors } : {}),
      })
    },
  )

  server.tool(
    "app_status",
    "Status of an app_run: its sessions' live descriptors, plus any workflow runs " +
      "belonging to the app (any run of one of its bundled WORKFLOW.md files, " +
      "however it was started).",
    { appRunId: z.string() },
    async input => {
      const run = appRegistry.getRun(input.appRunId)
      if (!run) return errorResult(`app_status: no app run "${input.appRunId}".`)
      const app = appRegistry.getApp(run.appId)
      const sessions = run.sessions.map(s => ({
        agentId: s.agentId,
        sessionId: s.sessionId,
        descriptor: registry.get(s.sessionId),
      }))
      const workflowRuns =
        workflowRunner && app
          ? workflowRunner.list().filter(r => app.workflows.some(w => w.id === r.workflowId))
          : []
      return textResult({
        appRunId: run.appRunId,
        appId: run.appId,
        status: run.status,
        startedAt: run.startedAt,
        ...(run.endedAt ? { endedAt: run.endedAt } : {}),
        sessions,
        workflowRuns,
      })
    },
  )

  server.tool(
    "app_stop",
    "Kill every session in an app_run (existing kill path) and mark the run ended.",
    { appRunId: z.string() },
    async input => {
      const run = appRegistry.getRun(input.appRunId)
      if (!run) return errorResult(`app_stop: no app run "${input.appRunId}".`)
      const killed: string[] = []
      const notFound: string[] = []
      for (const s of run.sessions) {
        if (registry.kill(s.sessionId)) killed.push(s.sessionId)
        else notFound.push(s.sessionId)
      }
      const ended = appRegistry.endRun(input.appRunId)
      return textResult({
        appRunId: input.appRunId,
        killed,
        ...(notFound.length > 0 ? { notFound } : {}),
        status: ended?.status ?? run.status,
      })
    },
  )

  server.tool(
    "app_apply",
    "Apply an app to a scope, making its capabilities available in that scope. " +
      "If the app is not installed and `dir` is provided, installs it first. " +
      "Validates that all `requires` dependencies are already applied to the same scope. " +
      "Idempotent — re-applying the same app to the same scope updates the timestamp.",
    {
      appId: z.string(),
      scopeId: z.string().optional().describe("Scope to apply to. Defaults to 'root'."),
      dir: z.string().optional().describe("Absolute path to install from if not already installed."),
    },
    async input => {
      const scopeId = input.scopeId ?? "root"
      let installed = appRegistry.getApp(input.appId)

      if (!installed && input.dir) {
        const installResult = await performInstall(input.dir, appRegistry, listRegisteredToolIds, resolveAgentAdapter)
        if (!installResult.ok) return errorResult(`app_apply: ${installResult.error}`)
        installed = installResult.record
      } else if (!installed) {
        return errorResult(
          `app_apply: app "${input.appId}" is not installed. Either call app_install first or provide a 'dir' parameter.`,
        )
      }

      if (installed.requires && installed.requires.length > 0) {
        const applied = appRegistry.listApplied(scopeId)
        const appliedIds = new Set(applied.map(m => m.appId))
        const missing = installed.requires.filter(reqId => !appliedIds.has(reqId))
        if (missing.length > 0) {
          return errorResult(
            `app_apply: app "${input.appId}" requires the following apps to be applied to scope "${scopeId}" first: ${missing.join(", ")}`,
          )
        }
      }

      const mount = appRegistry.applyApp({ scopeId, appId: input.appId })
      return textResult({
        scopeId: mount.scopeId,
        appId: mount.appId,
        appliedAt: mount.appliedAt,
        agents: installed.agents,
        workflows: installed.workflows,
        unvalidatedAgentTools: installed.unvalidatedAgentTools,
      })
    },
  )

  server.tool(
    "app_unapply",
    "Remove an app from a scope. Refuses if another applied app in the same scope requires this one.",
    {
      appId: z.string(),
      scopeId: z.string().optional().describe("Scope to unapply from. Defaults to 'root'."),
    },
    async input => {
      const scopeId = input.scopeId ?? "root"
      const applied = appRegistry.listApplied(scopeId)
      const dependents: string[] = []

      for (const mount of applied) {
        if (mount.appId === input.appId) continue
        const app = appRegistry.getApp(mount.appId)
        if (app?.requires?.includes(input.appId)) {
          dependents.push(mount.appId)
        }
      }

      if (dependents.length > 0) {
        return errorResult(
          `app_unapply: cannot unapply app "${input.appId}" from scope "${scopeId}" — ` +
            `the following apps in this scope require it: ${dependents.join(", ")}`,
        )
      }

      const removed = appRegistry.unapplyApp({ scopeId, appId: input.appId })
      if (!removed) {
        return errorResult(`app_unapply: app "${input.appId}" is not applied to scope "${scopeId}".`)
      }

      return textResult({ scopeId: removed.scopeId, appId: removed.appId, appliedAt: removed.appliedAt })
    },
  )

  server.tool(
    "app_list_applied",
    "List applied mounts, optionally filtered by scope. Each mount is joined with its installed app summary.",
    {
      scopeId: z.string().optional().describe("Filter by scope. Omit to list all scopes."),
    },
    async input => {
      const mounts = appRegistry.listApplied(input.scopeId)
      const result = mounts.map(mount => {
        const app = appRegistry.getApp(mount.appId)
        return {
          scopeId: mount.scopeId,
          appId: mount.appId,
          appliedAt: mount.appliedAt,
          ...(app
            ? {
                agents: app.agents,
                workflows: app.workflows,
                unvalidatedAgentTools: app.unvalidatedAgentTools,
              }
            : {}),
        }
      })
      return textResult(result)
    },
  )

  server.tool(
    "app_tool_call",
    "Call one of an installed app's UI-exposed tools — the allowlist set at " +
      "`defineApp({ ui: { tools: [...] } })` time (`app_install`'s `record.ui.tools`). " +
      "A tool id prefixed `imported:<alias>/<toolName>` dispatches through an imported " +
      "MCP server (same proxy `mcp_imported_call` uses); every other id dispatches " +
      "through the daemon's own registered tools (same reach-in routine/cron `target.tool` " +
      "dispatch uses).",
    {
      appId: z.string(),
      tool: z.string().describe("A tool id from the app's `ui.tools` allowlist."),
      args: z.record(z.string(), z.unknown()).optional().describe("Tool arguments. Default: empty object."),
    },
    async input =>
      performAppToolCall(appRegistry, input, {
        ...(dispatchTool ? { dispatchTool } : {}),
        ...(callImportedTool ? { callImportedTool } : {}),
      }),
  )

  server.tool(
    "app_uninstall",
    "Remove an installed app's record. Refuses if the app is applied to any scope " +
      "(unapply first via app_unapply) or has a running app_run (stop it first via app_stop).",
    { appId: z.string() },
    async input => {
      const applied = appRegistry.listApplied().filter(m => m.appId === input.appId)
      if (applied.length > 0) {
        return errorResult(
          `app_uninstall: app "${input.appId}" is applied to scope(s) ` +
            `${applied.map(m => m.scopeId).join(", ")} — unapply from scopes first.`,
        )
      }

      const runningRuns = appRegistry
        .listRuns()
        .filter(r => r.appId === input.appId && r.status === "running")
      if (runningRuns.length > 0) {
        return errorResult(
          `app_uninstall: app "${input.appId}" has running app_run(s) ` +
            `${runningRuns.map(r => r.appRunId).join(", ")} — stop app runs first.`,
        )
      }

      const removed = appRegistry.removeApp(input.appId)
      if (!removed) {
        return errorResult(`app_uninstall: no installed app "${input.appId}".`)
      }
      return textResult({ appId: removed.appId })
    },
  )

  server.tool(
    "app_catalog",
    "List browsable apps from the catalog file (default `~/.agentproto/app-catalog.json`, " +
      "tolerates a missing file), merged with installed-app status — every entry reports " +
      "`installed`, `hasUi`, `hasArtifact`, and `hasSkill`. Installed apps absent from the catalog file are included too.",
    {
      scopeId: z
        .string()
        .optional()
        .describe("Reserved for future scope-aware filtering. Currently unused."),
    },
    async () => {
      const catalog = await loadAppCatalogFile(opts.catalogPath)
      const installedApps = appRegistry.listApps()
      const installedById = new Map(installedApps.map(a => [a.appId, a]))
      const seen = new Set<string>()

      const entries = catalog.apps.map(entry => {
        const installed = installedById.get(entry.appId)
        seen.add(entry.appId)
        const name = entry.name ?? installed?.name
        const description = entry.description ?? installed?.description
        return {
          appId: entry.appId,
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
          dir: entry.dir,
          ...(entry.category ? { category: entry.category } : {}),
          installed: installed !== undefined,
          hasUi: installed?.ui !== undefined,
          hasArtifact: installed?.artifact !== undefined,
          hasSkill: installed?.skill !== undefined,
        }
      })

      for (const app of installedApps) {
        if (seen.has(app.appId)) continue
        entries.push({
          appId: app.appId,
          ...(app.name ? { name: app.name } : {}),
          ...(app.description ? { description: app.description } : {}),
          dir: app.dir,
          installed: true,
          hasUi: app.ui !== undefined,
          hasArtifact: app.artifact !== undefined,
          hasSkill: app.skill !== undefined,
        })
      }

      return textResult(entries)
    },
  )

  server.tool(
    "app_artifact_get",
    "Return the artifact HTML content for an installed app. The host agent " +
      "(Cowork) calls `create_artifact` with this content — the daemon exposes " +
      "the content; it never writes the host manifest directly. Errors if the " +
      "app has no artifact.",
    { appId: z.string() },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) {
        return errorResult(`app_artifact_get: no installed app "${input.appId}".`)
      }
      if (!installed.artifact) {
        return errorResult(`app_artifact_get: app "${input.appId}" has no artifact.`)
      }
      let html: string
      try {
        html = await readFile(installed.artifact.path, "utf8")
      } catch (err) {
        return errorResult(
          `app_artifact_get: could not read artifact "${installed.artifact.path}": ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return textResult({
        appId: installed.appId,
        ...(installed.artifact.title ? { title: installed.artifact.title } : {}),
        ...(installed.artifact.description ? { description: installed.artifact.description } : {}),
        html,
      })
    },
  )

  server.tool(
    "app_skill_get",
    "Return the skill files for an installed app. Reads the skill directory " +
      "from disk at call time and returns every file's content (utf-8 text " +
      "only — binary files are skipped with a warning in the response). " +
      "The host agent (Cowork) calls `save_skill` with this content — the " +
      "daemon exposes the content; it never writes the host manifest directly. " +
      "Errors if the app has no skill.",
    { appId: z.string() },
    async input => {
      const installed = appRegistry.getApp(input.appId)
      if (!installed) {
        return errorResult(`app_skill_get: no installed app "${input.appId}".`)
      }
      if (!installed.skill) {
        return errorResult(`app_skill_get: app "${input.appId}" has no skill.`)
      }
      const skillDir = installed.skill.path
      let skillSource: string
      try {
        skillSource = await readFile(join(skillDir, "SKILL.md"), "utf8")
      } catch (err) {
        return errorResult(
          `app_skill_get: could not read SKILL.md in "${skillDir}": ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
      const skillFm = matter(skillSource).data as { name?: unknown; description?: unknown }
      const name = typeof skillFm.name === "string" ? skillFm.name : installed.skill.title ?? "untitled"
      const description = typeof skillFm.description === "string" ? skillFm.description : installed.skill.description

      const files: { path: string; content: string }[] = []
      const skipped: string[] = []
      const binaryExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".zip", ".tar", ".gz"])

      try {
        const entries = await readdir(skillDir, { withFileTypes: true })
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const fullPath = join(skillDir, entry.name)
          if (entry.isDirectory()) continue
          const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase()
          if (binaryExts.has(ext)) {
            skipped.push(entry.name)
            continue
          }
          try {
            const content = await readFile(fullPath, "utf8")
            files.push({ path: entry.name, content })
          } catch {
            skipped.push(entry.name)
          }
        }
      } catch (err) {
        return errorResult(
          `app_skill_get: could not read skill directory "${skillDir}": ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }

      const result: Record<string, unknown> = {
        appId: installed.appId,
        name,
        ...(description ? { description } : {}),
        files,
      }
      if (skipped.length > 0) result.skipped = skipped
      return textResult(result)
    },
  )
}
