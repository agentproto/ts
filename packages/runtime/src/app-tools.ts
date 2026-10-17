/**
 * MCP tools that install and run `@agentproto/app-kit` apps — a bundle of
 * one or more AIP-42 agents plus the AIP-15 workflows they run, emitted
 * under `<dir>/.agentproto/` by `defineApp().emit(dir)`.
 *
 * Tools:
 *   app_install   loadAppHandle(dir) → validate → persist an installed-app record
 *   app_list      installed apps + a runs summary
 *   app_run       spawn a session per selected agent (default mastra-agent;
 *                 adapter/harness/model are pass-through, optional `sequence`
 *                 runs agents one-at-a-time under one appRunId)
 *   app_status    fan out an app_run's sessions + the app's workflow runs
 *   app_stop      kill an app_run's sessions
 *
 * `app_install` moves workflow-step tool-id validation from STEP-DISPATCH
 * time (where it used to surface, deep into a run — see
 * `output/phase-a-findings.md` A2: `unknown daemon tool "apply_patch"`) to
 * install time, listing every missing id at once instead of failing one
 * step at a time.
 */

import { existsSync } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import matter from "gray-matter"
import { z, type ZodRawShape } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { loadAppHandle, loadAppBundledTools, peekAppUi, versionSatisfies, type AppUiBuildConfig, type OpenAIAppUiExtension } from "@agentproto/app-kit"
import { ensureAppUiBuilt } from "./app-ui-build.js"
import { parseModelRoleRef } from "./model-roles.js"
import { loadAgent } from "@agentproto/agent"
import type { AgentHandle, AnyRef } from "@agentproto/agent"
import type { AgentRefResolution } from "@agentproto/workflow-runtime"
import { APP_UI_DISCOVERY_TOOLS } from "@agentproto/app-client/runner-select"
import type { ToolHandle } from "@agentproto/tool"
import { runTool } from "@agentproto/driver"
import { createDaemonToolRegistry, type AppToolRegistry } from "./workflow-tool-registry.js"
import { spawnAgentSession } from "./session-spawn.js"
import { prefixPrompt, projectAgentToSpawn, type AgentProjectionCaps } from "./agent-projection.js"
import { buildAppBoundary } from "./app-boundary.js"
import { ensureAppWorkspace, registerAppWorkspace, unregisterAppWorkspace } from "./app-workspace.js"
import {
  buildServiceOwnerPrompt,
  createAppServiceStore,
  ensureAppServiceOwners,
  killServicePid,
  parseAppServices,
  reensureAppServiceOwners,
  removeAppServiceOwners,
  serviceOwnerLabel,
  servicePidFilePath,
  type AppService,
  type EnsureAppServiceOwnersResult,
  type AppServiceOwner,
  type AppServiceStore,
  type SpawnServiceOwner,
  type SpawnServiceOwnerResult,
} from "./app-services.js"
import type { SessionsRegistry } from "./sessions.js"
import type { AgentAdapterResolver } from "./http-server.js"
import type { WorkflowRunner } from "./workflow-runner.js"
import { createAppRegistry, APP_DATA_ROOT_SUBDIR, defaultRemoteAppDataDir, type AppRegistry, type AppSource, type InstalledApp, type InstalledAppRef } from "./app-registry.js"
import { mintAppLinkToken } from "./app-link-token.js"
import {
  APP_INSTALL_EXCLUSIVE_ERROR,
  appInstallInputSchema,
  isAgentappUrl,
  remoteGitSha,
  stageAgentApp,
  stageGitApp,
  swapInStaged,
  type StagedApp,
} from "./app-remote-install.js"
import { appDataDir, DEFAULT_APP_DATA_SUBDIR } from "./app-data.js"
import { reconcileAppRunStatus } from "./app-run-liveness.js"
import { compactWorkflowRunStatus } from "./orchestration-tools.js"
import { appStateLedgerExists, appStateSnapshot } from "./app-state.js"
import {
  loadAppCatalogFile,
  createRemoteCatalogClient,
  isCatalogUpdate,
  resolveCatalogSources,
  type AppCatalogEntry,
  type RemoteCatalogClient,
} from "./app-catalog.js"
import { FIRST_PARTY_CATALOG_ENTRIES } from "./first-party-catalog.js"
import { loadConfig, type CatalogConfig } from "./config.js"
import { builtinPanelCatalogEntries } from "./builtin-apps.js"
import { paginate, pageParamsShape, toolText, type PageParams } from "./tool-envelope.js"
import { catchErrors, type ToolTransformer } from "@agentproto/tool"
import { registerBuiltinTool } from "@agentproto/mcp-server"
import { createHash, randomBytes } from "node:crypto"

type McpTextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean }

/**
 * Local companion to the shared `paginated()` transformer for tools whose
 * LEGACY (non-paginated) output is not `paginated`'s `{[itemKey]: rows}`
 * wrapper — here, a bare top-level array. Composed INSIDE `catchErrors()`
 * and OUTSIDE `paginated()` semantics-wise, it re-implements the same
 * cursor/limit/compact/fields pipeline via the shared primitives, but the
 * default branch (no limit/cursor) emits `defaultBody(projectedRows)`
 * instead of the `{items: ...}` envelope, and any non-array handler output
 * (this file's `errorResult(...)` replies) passes through untouched.
 */
function paginatedLegacyList<TItem extends object>(opts: {
  project: (item: TItem) => object
  keyOf: (item: TItem) => string | number | null
  defaultBody: (rows: object[], input: unknown) => unknown
}): ToolTransformer<unknown, unknown, McpTextResult> {
  return {
    name: "paginatedLegacyList",
    wrapShape: (shape): ZodRawShape => ({ ...shape, ...pageParamsShape }),
    wrapHandler: inner => async input => {
      const params = (input ?? {}) as PageParams
      const out = (await inner(input)) as unknown
      if (!Array.isArray(out)) return out as McpTextResult
      const items = out as readonly TItem[]
      const full = params.full === true
      const compact = full ? false : params.compact !== false
      if (params.limit !== undefined || params.cursor !== undefined) {
        const page = paginate(items, params, { maxLimit: 200, keyOf: opts.keyOf })
        const rows = compact ? page.items.map(opts.project) : page.items
        return { content: [{ type: "text", text: toolText({ ...page, items: [...rows] }, params) }] }
      }
      const rows = compact ? items.map(opts.project) : [...items]
      return { content: [{ type: "text", text: JSON.stringify(opts.defaultBody(rows as object[], input)) }] }
    },
  }
}

/** mastra-agent's adapter slug — the one agent adapter this WP knows how to
 *  run an emitted AGENT.md under via its `agent` option (`--agent <path>`).
 *  No longer a silent fallback: an agent only lands here when its own
 *  `metadata.adapter`/`metadata.harness` (or a caller-passed `adapter`)
 *  names it. */
const DEFAULT_AGENT_ADAPTER = "mastra-agent"

/** A spawned session descriptor's terminal statuses (see `SessionStatus` in
 *  sessions.ts): clean exit, operator kill, or a crash/error. Any of these
 *  means the session is no longer running and a sequential run can advance. */
const TERMINAL_SESSION_STATUSES = new Set(["exited", "killed", "error"])

function isSessionTerminal(status: string | undefined): boolean {
  return status === undefined || TERMINAL_SESSION_STATUSES.has(status)
}

/** True when a stringified output carries no substantive content — guards the
 *  empty-text-block case (`content: [{type:"text", text:""}]`) from surfacing
 *  as a truthy-but-blank output downstream (D). */
export function isBlankText(line: string): boolean {
  return line === undefined || line.trim().length === 0
}

/** Drop `{type:"text"}` content blocks whose `text` is empty/whitespace so a
 *  session ending with a blank block is never forwarded/echoed as truthy. */
export function sanitizeOutputBlocks(
  blocks: ReadonlyArray<{ type: string; text?: string }> | undefined,
): Array<{ type: string; text: string }> {
  if (!blocks) return []
  return blocks.filter(b => !(b.type === "text" && isBlankText(b.text ?? ""))).map(b => ({
    type: b.type,
    text: b.text ?? "",
  }))
}

/** Bounded poll for a single spawned session to reach a terminal descriptor
 *  status (or disappear from the registry) — the sequential-orchestration
 *  primitive. Sleeps between polls so it never blocks the daemon event loop,
 *  and caps at `MAX_SEQUENTIAL_POLLS` so a hung session can't stall a run
 *  forever (the run then falls back to app_status's lazy reconciliation). */
const SEQUENTIAL_POLL_INTERVAL_MS = 2_000
const MAX_SEQUENTIAL_POLLS = 60

async function waitForSessionTerminal(
  registry: SessionsRegistry,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_SEQUENTIAL_POLLS; attempt++) {
    const status = registry.get(sessionId)?.status
    if (isSessionTerminal(status)) return
    await new Promise(resolve => setTimeout(resolve, SEQUENTIAL_POLL_INTERVAL_MS))
  }
}

/** F26 model-based adapter route: a `claude-*` model id (bare, or after a
 *  `provider/` prefix — AIP-42's `modelRef` allows either shorthand) runs on
 *  `claude-code`, matching the daemon's own routing rule that Claude models
 *  run on claude-code. */
export const MODEL_ROUTED_ADAPTER = "claude-code"

/** Resolves a model ROLE (`review.large`) to a model id — see `model-roles.ts`. */
export type ModelRoleResolver = (role: string) => Promise<string | undefined>

/**
 * An AGENT.md `model:` may be `role:<name>` (see `model-roles.ts`) instead of
 * a model id: resolve it now, before adapter selection or spawn. A role that
 * cannot be resolved yields `undefined` (no model route — the agent then
 * needs `metadata.adapter` or a caller-passed `adapter`) rather than leaking
 * the raw `role:` string to a model API.
 */
export async function resolveAgentModelRef(
  model: string | undefined,
  resolveRole?: ModelRoleResolver,
): Promise<string | undefined> {
  if (model === undefined) return undefined
  const role = parseModelRoleRef(model)
  if (role === undefined) return model
  return resolveRole ? resolveRole(role) : undefined
}

/** Model-route adapter mapping (see {@link MODEL_ROUTED_ADAPTER}): a
 *  `claude-*` bare id routes to claude-code; `opencode/`/`opencode-go/`
 *  models route to opencode. Anything else — including no model at all —
 *  has NO model-based route: the agent must declare
 *  `metadata.adapter`/`metadata.harness`, or the caller must pass `adapter`
 *  to `app_run`, rather than silently falling back to mastra-agent. */
function defaultAdapterForModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  if (model.startsWith("opencode/") || model.startsWith("opencode-go/")) return "opencode"
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model
  return bare.startsWith("claude-") ? MODEL_ROUTED_ADAPTER : undefined
}

/**
 * F26 spec gap: AIP-42's AGENT.schema.json (`specs/resources/aip-42/draft/
 * AGENT.schema.json`) has no `adapter`/`harness` field — its frontmatter is
 * `.strict()` (`packages/agent/src/schema.ts`), so a bare top-level
 * `adapter:`/`harness:` key fails `app_install`'s manifest validation before
 * this ever runs. `metadata` is the only `additionalProperties: true` escape
 * hatch AIP-42 offers today, so that's where an app author's adapter/harness
 * override has to live (`metadata.adapter` or `metadata.harness`, either
 * name). This should probably become a first-class AIP-42 field; flagged
 * here rather than fixed, since editing the spec is a bigger, separate
 * change than this bug fix.
 */
function agentMetadataAdapter(metadata: { [k: string]: unknown } | undefined): string | undefined {
  const value = metadata?.adapter ?? metadata?.harness
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

/**
 * The F26 per-agent adapter order, in one place, shared by
 * {@link resolveAgentRefsForWorkflow} (workflow agent refs) and `app_run`
 * (one spawn per agent): the agent's OWN AGENT.md `metadata.adapter`/
 * `metadata.harness` override > a model-based route (see
 * {@link defaultAdapterForModel}). There is NO blanket fallback: an agent
 * that resolves to nothing here fails with {@link noAdapterError} instead
 * of silently running on mastra-agent.
 *
 * Takes the already-loaded AGENT.md facts instead of a path so neither caller
 * reads the file twice: `model` is the agent's declared model AFTER
 * {@link resolveAgentModelRef} role resolution, `metadata` its raw
 * frontmatter `metadata`, and `modelOverride` a caller-pinned model (app_run's
 * `input.model`) which — when set — decides the model-based route INSTEAD of
 * the agent's own.
 */
function resolveAgentSpawnAdapter(
  model: string | undefined,
  metadata: { [k: string]: unknown } | undefined,
  modelOverride?: string,
): string | undefined {
  return agentMetadataAdapter(metadata) ?? defaultAdapterForModel(modelOverride ?? model)
}

/** The shared failure for an agent whose adapter cannot be resolved: no
 *  `metadata.adapter`/`metadata.harness` and no model route. Callers either
 *  put this in an `app_run` run's `errors` list (per-agent) or throw it
 *  (workflow agent-ref resolution). */
function noAdapterError(agentId: string): string {
  return `agent "${agentId}" has no adapter: set metadata.adapter in its AGENT.md, use a claude-*, opencode/* or opencode-go/* model, or pass adapter to app_run`
}

/**
 * Build `compileWorkflow`'s `agentRefs` map for a workflow bundled by an
 * installed app — every agent id the app bundles resolves to a spawn adapter
 * chosen in order (F26, see {@link resolveAgentSpawnAdapter}): the agent's OWN
 * AGENT.md `metadata.adapter`/`metadata.harness` override > a model-based
 * route (see {@link defaultAdapterForModel}). An agent that resolves to
 * nothing throws ({@link noAdapterError}) — there is no silent
 * mastra-agent fallback. A step's own `adapter:` still wins
 * over all of this — `compileAgentStep` only applies `resolved.adapter` when
 * the step itself sets none. AGENT.md's declared `model` is forwarded too
 * (`AgentRefResolution.model`), so a step that sets no `model` of its own
 * still gets the agent's.
 *
 * Everything else the AGENT.md declares travels through the same
 * projection `app_run` uses (`projectAgentToSpawn`, agent-projection.ts):
 * an adapter whose manifest names an AGENT.md-path option
 * (`agentManifestOption`, mastra-agent) gets the path as that option;
 * every other adapter gets the rendered instructions (body + persona +
 * boundaries + traits — prepended to the step's prompt), the declared
 * skills, the declared tools (gateway scope) and the warnings for what the
 * harness can't honour.
 *
 * Returns undefined when no installed app bundles `workflowId` (a plain
 * `workflow_run_file` outside any app), so a `kind:"agent"` step using
 * `agent.ref` fails compilation naming "no agent refs are configured"
 * rather than a silently-empty map producing the same message either way.
 */
export async function resolveAgentRefsForWorkflow(
  appRegistry: AppRegistry,
  workflowId: string,
  resolveRole?: ModelRoleResolver,
  resolveAgentAdapter?: AgentAdapterResolver,
): Promise<Record<string, AgentRefResolution> | undefined> {
  const app = appRegistry.listApps().find(a => a.workflows.some(w => w.id === workflowId))
  if (!app) return undefined
  const refs: Record<string, AgentRefResolution> = {}
  const caps = new Map<string, Promise<AgentProjectionCaps>>()
  for (const agent of app.agents) {
    let loaded: LoadedAgentManifest | undefined
    try {
      loaded = await loadAgentPromptDefaults(agent.path, resolveRole)
    } catch {
      // AGENT.md unreadable/invalid at run time (already validated at
      // install) — if that leaves the agent with no adapter at all, the
      // no-adapter error below names it rather than silently degrading the
      // whole workflow.
    }
    const adapter = resolveAgentSpawnAdapter(loaded?.model, loaded?.metadata)
    if (adapter === undefined) throw new Error(noAdapterError(agent.id))
    if (loaded === undefined) {
      refs[agent.id] = { adapter }
      continue
    }
    let adapterCaps = caps.get(adapter)
    if (adapterCaps === undefined) {
      adapterCaps = projectionCapsFor(resolveAgentAdapter, adapter)
      caps.set(adapter, adapterCaps)
    }
    const projected = projectAgentToSpawn(loaded, await adapterCaps)
    refs[agent.id] = {
      adapter,
      ...(projected.options !== undefined ? { options: projected.options } : {}),
      ...(projected.model !== undefined ? { model: projected.model } : {}),
      ...(projected.tools !== undefined ? { tools: projected.tools } : {}),
      ...(projected.skills !== undefined ? { skills: projected.skills } : {}),
      ...(projected.instructions !== undefined ? { instructions: projected.instructions } : {}),
      ...(projected.systemPrompt !== undefined ? { systemPrompt: projected.systemPrompt } : {}),
      ...(projected.warnings.length > 0 ? { warnings: projected.warnings } : {}),
    }
  }
  return refs
}

/**
 * Walk up from `startDir` looking for an app root — a directory whose own
 * `.agentproto/APP.md` exists — stopping at the filesystem root. Mirrors how
 * `git`/`tsconfig` resolve upward from a file to its owning project: an
 * AIP-53 app's `workflows[].path` (APP.md frontmatter) is an arbitrary
 * relative path under the app dir, so there's no fixed depth to strip off a
 * WORKFLOW.md's own path — the marker file is the only reliable anchor.
 * Returns undefined when no ancestor carries one (a bare WORKFLOW.md with no
 * owning app bundle at all).
 */
function findAppRootFromFile(startDir: string): string | undefined {
  let dir = startDir
  for (;;) {
    if (existsSync(join(dir, ".agentproto", "APP.md"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Load the AIP-14/AIP-30 tool/driver bundles (BRIEF-D) that a `kind:"tool"`
 * step's driver scripts resolve against.
 *
 * F40 (AIP-58 dogfood): `workflowMdPath`, when given (a `workflow_run_file`
 * run), takes priority — the app root is resolved by walking UP from the
 * WORKFLOW.md's own directory ({@link findAppRootFromFile}), never from the
 * `app_install` registry. Without this, a WORKFLOW.md loaded from a git
 * worktree copy of an app still ran the INSTALLED copy's tool/driver
 * scripts (looked up by workflow id, which both copies declare identically)
 * — editing the worktree's DRIVER.md had no effect on the run it was
 * supposedly testing. No ancestor `.agentproto/APP.md` found ⇒ undefined
 * (a plain WORKFLOW.md with no owning app bundle), deliberately NOT falling
 * back to an id-based registry lookup — that fallback is exactly the bug.
 *
 * `workflowMdPath` omitted (a `workflow_start` run, addressed by workflow
 * id/app id, no file of its own) ⇒ the pre-F40 behaviour: the owning
 * installed app, found by `workflowId` in the registry.
 *
 * Either way this re-reads `<dir>/.agentproto/tools|drivers/*` off disk on
 * every call — the compiled `ToolHandle`/`DriverHandle` objects (with live
 * `execute` closures) aren't persisted on the `InstalledApp` record. Returns
 * undefined when the resolved dir bundles no tools/drivers either, so
 * `mergeAppAndDaemonToolRegistry` (workflow-tool-registry.ts) can treat
 * "nothing to merge" uniformly.
 */
export async function resolveAppToolsForWorkflow(
  appRegistry: AppRegistry,
  workflowId: string,
  workflowMdPath?: string,
): Promise<AppToolRegistry | undefined> {
  const dir =
    workflowMdPath !== undefined
      ? findAppRootFromFile(dirname(resolve(workflowMdPath)))
      : appRegistry.listApps().find(a => a.workflows.some(w => w.id === workflowId))?.dir
  if (dir === undefined) return undefined
  const { tools, drivers } = await loadAppBundledTools(dir)
  if (tools.length === 0 && drivers.length === 0) return undefined
  const toolsById: Record<string, ToolHandle> = {}
  for (const tool of tools) toolsById[tool.id] = tool
  return { tools: toolsById, candidates: drivers }
}

/** One AGENT.md read for both adapter selection ({@link
 *  resolveAgentSpawnAdapter}) and the spawn projection
 *  (`projectAgentToSpawn`): the parsed handle, its body, its declared model
 *  (string form only — a structured `ModelRef` has no single id to pass as
 *  `agent_start.model`) after role resolution, and its raw frontmatter
 *  `metadata`. */
export async function loadAgentPromptDefaults(
  agentPath: string,
  resolveRole?: ModelRoleResolver,
): Promise<LoadedAgentManifest> {
  const { handle, body } = await loadAgent(agentPath)
  const model = await resolveAgentModelRef(typeof handle.model === "string" ? handle.model : undefined, resolveRole)
  return {
    path: agentPath,
    handle,
    ...(model !== undefined ? { model } : {}),
    ...(handle.metadata !== undefined ? { metadata: handle.metadata } : {}),
    body,
  }
}

export interface LoadedAgentManifest {
  path: string
  handle: AgentHandle
  body: string
  model?: string
  metadata?: { [k: string]: unknown }
}

/** The resolver facts `projectAgentToSpawn` needs, read once per adapter
 *  slug. An unresolvable adapter projects as a plain harness (the spawn then
 *  fails on its own with `adapter_not_found`). */
async function projectionCapsFor(
  resolveAgentAdapter: AgentAdapterResolver | undefined,
  slug: string,
): Promise<AgentProjectionCaps> {
  const resolved = resolveAgentAdapter ? await resolveAgentAdapter(slug) : null
  if (!resolved) return {}
  return {
    ...(resolved.agentManifestOption !== undefined ? { agentManifestOption: resolved.agentManifestOption } : {}),
    ...(resolved.deliversSessionSkills ? { deliversSessionSkills: true } : {}),
    ...(resolved.supportsSystemPrompt ? { supportsSystemPrompt: true } : {}),
    ...(resolved.systemPromptMaxChars !== undefined ? { systemPromptMaxChars: resolved.systemPromptMaxChars } : {}),
    ...(resolved.declaredOptions !== undefined ? { declaredOptions: resolved.declaredOptions } : {}),
  }
}

function textResult(body: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(body) }] }
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
 * The `app_tool_call` gateway's whole behaviour minus allowlist resolution
 * — allowlist enforcement against the caller-supplied `declaredAllowlist`
 * UNION the read-only, non-secret `APP_UI_DISCOVERY_TOOLS` (`adapter_list`,
 * `harness_preset_list` — every app UI gets these for free, regardless of
 * what it declared, so `@agentproto/app-client/runner-select`'s
 * `mountRunnerSelect` works out of the box) — then dispatch through the
 * daemon's own tools or an imported MCP server. Factored out of
 * `performAppToolCall` so `performBuiltinPanelToolCall` can share the exact
 * same enforcement + dispatch against a builtin panel's `ui.tools` instead
 * of an `AppRegistry` record's — the allowlist source differs, the
 * enforcement and dispatch must not.
 */
/**
 * App-UI install confirmation (S6): `app_install` called from a panel's
 * `window.McpApp` bridge (the `tool-call` path — `dispatchAllowlistedAppTool`
 * above, shared by the `POST /apps/:appId/tool-call` REST twin and the
 * builtin panels' bridge, NOT the MCP verb itself) requires an explicit
 * two-step confirmation:
 *
 *   1st call (no `confirm`) → `{ needsConfirmation: true, confirm: <token>,
 *   kind, url, sha256|sha, ref?, subdir?, runsBuildCommand }` — an
 *   actionable install preview; NOTHING is installed, nothing is staged.
 *   2nd call with the SAME payload PLUS `confirm: <that token>` → the
 *   normal install path (nonce key stripped first — the tool's
 *   `appInstallInputSchema` is strict and doesn't declare it).
 *
 * The guard classifies by URL suffix ONLY (`isAgentappUrl`): a `.agentapp`
 * bundle never runs the app's ui.build (app-tools's `allowUiBuild`
 * contract), a git URL would only with `allowBuild: true` — which a
 * first-class reinstall stays free to pass, so the preview's
 * `runsBuildCommand = kind === "git" && allowBuild === true`.
 *
 * The token binds the caller to THE EXACT payload it previewed and to a
 * SERVER-ISSUED nonce, not a hash the caller could compute. Why a nonce
 * and not the sha256 of the payload: the payload is fully predictable
 * (it's the catalog entry's url/sha fields, or whatever a CSRF-forged POST
 * picks), so a deterministic token is computable by ANY caller — a blind
 * cross-site POST that never reads the preview could forge
 * `confirm: sha256(payload)` and the guard would pass, protecting
 * nothing. The confirm value is therefore `randomBytes(16)` hex, issued
 * ONLY by the preview call and stored server-side (nonce ->
 * { fingerprint of the payload, 5-minute expiry }), single-use: it is
 * deleted the moment a call carries it, successful or not, and a second
 * call with a different payload (or a stale/expired/unknown token) shows
 * a preview again — never proceeds. Issuance also purges expired entries
 * and caps the store (oldest evicted past 256 outstanding confirmations).
 *
 * Direct MCP/CLI callers enter through the registered `server.tool
 * ("app_install")` handler (below — the parsed `appInstallInputSchema`
 * code path), which this guard never touches; their behaviour is
 * byte-identical to before this change. Only the panel bridge's
 * `allowlist + dispatch` route (an app's OWN ui html, the most exposed
 * tool surface) pays the extra round trip.
 */
export interface AppInstallPreview {
  needsConfirmation: true
  /** The token the SECOND call must echo back (`confirm: <token>`). */
  confirm: string
  kind: "agentapp" | "git"
  url: string
  sha256?: string
  sha?: string
  ref?: string
  subdir?: string
  runsBuildCommand?: boolean
}

/** Canonical-JSON sha256 of the previewed fields — the payload's
 *  fingerprint, stored server-side against the nonce issued for it.
 *  `kind` is derived here (`isAgentappUrl`), taken from the URL; the
 *  fingerprint must be recomputed with the SAME derivation on the
 *  confirming call, so both call sites pass the SAME args surface. */
function confirmTokenOf(args: {
  url: string
  sha256?: string
  sha?: string
  ref?: string
  subdir?: string
  [k: string]: unknown
}): string {
  const digest = createHash("sha256")
  digest.update(
    JSON.stringify([
      "agentproto-app-install-confirm-v1",
      args.url,
      isAgentappUrl(args.url) ? "agentapp" : "git",
      args.sha256 ?? null,
      args.sha ?? null,
      args.ref ?? null,
      args.subdir ?? null,
      args.allowBuild === true,
    ]),
  )
  return digest.digest("hex").slice(0, 32)
}

/** Server-side nonce store for the app-UI install confirmation — module
 *  level because the guard must be shared by EVERY panel-facing
 *  dispatcher in the process (`dispatchAllowlistedAppTool` runs under
 *  both the builtin-panels route and the installed-apps route). Not a
 *  deterministic hash of the payload (a blind CSRF POST could compute
 *  that without ever seeing the preview — see the docblock above): the
 *  nonce exists only after a preview, in THIS process's memory. */
const appInstallNonces = new Map<string, { fingerprint: string; expiresAt: number }>()

/** Cap on outstanding (issued-but-unconfirmed) confirmations. Issuance
 *  purges expired entries first; past this cap the OLDEST entry is
 *  evicted (Map iteration order = insertion order), so the store can't
 *  grow without bound under preview spam. */
const APP_INSTALL_NONCE_MAX = 256

const APP_INSTALL_NONCE_TTL_MS = 5 * 60 * 1000

/** Issue a fresh single-use nonce for THIS payload: `randomBytes` hex,
 *  bound server-side to the payload's fingerprint + a 5-minute expiry.
 *  Purges expired entries and enforces the cap on every issuance. */
function issueInstallNonce(args: Record<string, unknown>): string {
  const now = Date.now()
  for (const [nonce, entry] of appInstallNonces) {
    if (entry.expiresAt <= now) appInstallNonces.delete(nonce)
  }
  if (appInstallNonces.size >= APP_INSTALL_NONCE_MAX) {
    const oldest = appInstallNonces.keys().next().value
    if (oldest !== undefined) appInstallNonces.delete(oldest)
  }
  const nonce = randomBytes(16).toString("hex")
  appInstallNonces.set(nonce, {
    fingerprint: confirmTokenOf({
      url: typeof args.url === "string" ? args.url : "",
      sha256: typeof args.sha256 === "string" ? args.sha256 : undefined,
      sha: typeof args.sha === "string" ? args.sha : undefined,
      ref: typeof args.ref === "string" ? args.ref : undefined,
      subdir: typeof args.subdir === "string" ? args.subdir : undefined,
      allowBuild: args.allowBuild === true,
    }),
    expiresAt: now + APP_INSTALL_NONCE_TTL_MS,
  })
  return nonce
}

/**
 * Whether an app-UI-path `app_install` call carries the confirmation it
 * needs: `undefined` when the payload isn't a recognisable remote install
 * (the guard lets it through to the tool's own validation error), `false`
 * when it's a fresh remote install with no (valid) confirm, `true` only
 * when the echoed token is a live server-issued nonce whose fingerprint
 * matches THIS payload. Consumptive: ANY call carrying a string `confirm`
 * deletes that nonce (single use, success or not); a caller presenting a
 * non-nonce string (a self-computed hash, a replay, an expired nonce) or
 * a modified payload gets `{confirmed: false}` and, with it, a fresh
 * preview from the dispatcher.
 */
export function appInstallConfirmationClass(args: Record<string, unknown>):
  | { confirmed: true }
  | { confirmed: false }
  | undefined {
  const url = args.url
  if (typeof url !== "string" || url.trim() === "" || args.dir !== undefined || args.file !== undefined) {
    return undefined
  }
  if (typeof args.confirm !== "string") return { confirmed: false }
  const nonce = appInstallNonces.get(args.confirm)
  appInstallNonces.delete(args.confirm)
  const fingerprint = confirmTokenOf({
    url,
    sha256: typeof args.sha256 === "string" ? args.sha256 : undefined,
    sha: typeof args.sha === "string" ? args.sha : undefined,
    ref: typeof args.ref === "string" ? args.ref : undefined,
    subdir: typeof args.subdir === "string" ? args.subdir : undefined,
    allowBuild: args.allowBuild === true,
  })
  const valid = nonce !== undefined && nonce.fingerprint === fingerprint && Date.now() < nonce.expiresAt
  return valid ? { confirmed: true } : { confirmed: false }
}

/** The preview the FIRST call sees. Never stages or installs — it ISSUES
 *  the single-use nonce the second call must echo back. */
export function buildAppInstallPreview(args: Record<string, unknown>): AppInstallPreview {
  const url = typeof args.url === "string" ? args.url : ""
  const isAgentapp = isAgentappUrl(url)
  return {
    needsConfirmation: true,
    confirm: issueInstallNonce(args),
    kind: isAgentapp ? "agentapp" : "git",
    url,
    ...(typeof args.sha256 === "string" ? { sha256: args.sha256 } : {}),
    ...(typeof args.sha === "string" ? { sha: args.sha } : {}),
    ...(typeof args.ref === "string" ? { ref: args.ref } : {}),
    ...(typeof args.subdir === "string" ? { subdir: args.subdir } : {}),
    runsBuildCommand: !isAgentapp && args.allowBuild === true,
  }
}

/**
 * A verified AIP-53 link-SESSION token's claims, paired with the app's own
 * `ui.toolScope` declaration — everything `dispatchAllowlistedAppTool` needs
 * to run in SCOPED mode instead of its normal `ui.tools` allowlist check.
 * Resolved by http-server.ts (`appLinkToolCallAuth`) from the request, never
 * trusted from anywhere else.
 */
export interface AppLinkScope {
  toolScope: Readonly<Record<string, Readonly<Record<string, string>>>>
  claims: Readonly<Record<string, string>>
}

function parseLinkClaimRef(claimRef: string): string | undefined {
  return claimRef.startsWith("$link.") ? claimRef.slice("$link.".length) : undefined
}

async function dispatchAllowlistedAppTool(
  declaredAllowlist: readonly string[],
  input: { appId: string; tool: string; args?: Record<string, unknown> },
  deps: AppToolCallDeps,
  appDir?: string,
  linkScope?: AppLinkScope,
): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  // `app_link_mint` is privileged (mints a scoped token — app-link-token.ts)
  // and must NEVER be reachable through this gateway at all, scoped or not:
  // `defineApp` already refuses to let an app put it in `ui.tools`, but a
  // builtin panel's allowlist isn't app-kit-validated, so this is the
  // actual fail-closed enforcement.
  if (input.tool === "app_link_mint") {
    return errorResult(`app_tool_call: "app_link_mint" is a privileged daemon action, never reachable via app_tool_call.`)
  }

  let args: Record<string, unknown>
  if (linkScope) {
    // Scoped mode (a Telegram-authorized link-session token): the token's
    // own `ui.toolScope` entries are the WHOLE allowlist — no
    // `APP_UI_DISCOVERY_TOOLS` union, no bundled/imported-tool exemption
    // beyond what's declared. A link proves identity for one session; it
    // must not become a parallel allowlist shaped differently from the
    // UI's own.
    const argMap = linkScope.toolScope[input.tool]
    if (!argMap) {
      return errorResult(
        `app_tool_call: tool "${input.tool}" is not in app "${input.appId}"'s ui.toolScope — refused under a scoped link token.`,
      )
    }
    const scopedArgs: Record<string, unknown> = { ...(input.args ?? {}) }
    for (const [argName, claimRef] of Object.entries(argMap)) {
      const claimName = parseLinkClaimRef(claimRef)
      const claimValue = claimName ? linkScope.claims[claimName] : undefined
      if (claimValue === undefined) {
        return errorResult(
          `app_tool_call: scoped link token carries no claim for "${claimRef}" (required by "${input.tool}"'s "${argName}" argument).`,
        )
      }
      if (scopedArgs[argName] === undefined) {
        scopedArgs[argName] = claimValue
      } else if (scopedArgs[argName] !== claimValue) {
        return errorResult(
          `app_tool_call: argument "${argName}" does not match this link's "${claimRef}" claim — refused.`,
        )
      }
    }
    args = scopedArgs
  } else {
    const effectiveAllowlist: readonly string[] = [...declaredAllowlist, ...APP_UI_DISCOVERY_TOOLS]
    if (!effectiveAllowlist.includes(input.tool)) {
      return errorResult(
        `app_tool_call: tool "${input.tool}" is not in app "${input.appId}"'s ui.tools allowlist: ` +
          `${declaredAllowlist.length > 0 ? declaredAllowlist.join(", ") : "(empty)"}`,
      )
    }
    args = input.args ?? {}
  }
  // App-UI install guard: an `app_install` routed through an app panel's
  // tool-call surface (`window.McpApp` bridge → this dispatcher) needs an
  // EXPLICIT confirmation — first call (no `confirm`) answers a preview
  // and installs nothing; only a second call echoing the preview's
  // `confirm` token proceeds (then stripped before dispatch — the tool's
  // own schema is strict and doesn't know the nonce key). Direct MCP/CLI
  // callers enter through the registered `server.tool("app_install")`
  // handler, never this dispatcher, and are unaffected.
  let dispatchArgs = args
  if (input.tool === "app_install") {
    const cls = appInstallConfirmationClass(args)
    if (cls?.confirmed === false) return textResult(buildAppInstallPreview(args))
    if (cls?.confirmed === true) {
      const { confirm: _confirmNonce, ...rest } = args
      dispatchArgs = rest
    }
  }
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
      const result = await deps.callImportedTool(rest.slice(0, slash), rest.slice(slash + 1), dispatchArgs)
      return textResult(result)
    }
    // G1: an allowlisted id that names one of the app's OWN bundled TOOL.md
    // contracts runs through the app's DRIVER.md implementations (AIP-30
    // runTool), the same pair `resolveAppToolsForWorkflow` hands workflows.
    // Re-read from disk per call, like the workflow path: the compiled
    // handles are not persisted on the InstalledApp record.
    if (appDir !== undefined) {
      const bundled = await loadAppBundledTools(appDir)
      const bundledTool = bundled.tools.find(t => t.id === input.tool)
      if (bundledTool) {
        const output = await runTool({ tool: bundledTool, candidates: bundled.drivers, input: args })
        return textResult(output)
      }
    }
    if (!deps.dispatchTool) return notEnabled("app_tool_call")
    const result = await deps.dispatchTool(input.tool, dispatchArgs)
    // `result` is usually already an MCP envelope, so this wraps it a second
    // time. Installed apps and the builtin panel bridge
    // (packages/apps/src/panel-bridge.ts `_unwrapToolResult`) unwrap
    // recursively and depend on this shape — don't flatten it here.
    return textResult(result)
  } catch (err) {
    return errorResult(`app_tool_call: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * The `app_tool_call` gateway's whole behaviour — allowlist enforcement
 * against the installed app's `ui.tools` UNION `APP_UI_DISCOVERY_TOOLS` (see
 * `dispatchAllowlistedAppTool`), then dispatch. Shared verbatim between the
 * MCP verb below and the HTTP twin (`POST /apps/:appId/tool-call`,
 * http-server.ts) so the two surfaces can never drift. Returns the MCP
 * result envelope both callers hand back untouched.
 */
export async function performAppToolCall(
  appRegistry: AppRegistry,
  input: { appId: string; tool: string; args?: Record<string, unknown> },
  deps: AppToolCallDeps,
  /** Claims from a verified link-SESSION token (http-server.ts's
   *  `appLinkToolCallAuth`), when the request carried one. Combined here
   *  with the installed app's OWN `ui.toolScope` declaration — the caller
   *  never supplies the scope map itself. */
  linkClaims?: Readonly<Record<string, string>>,
): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  const installed = appRegistry.getApp(input.appId)
  if (!installed || !installed.ui) {
    return errorResult(`app_tool_call: app "${input.appId}" is not installed or has no UI.`)
  }
  const linkScope: AppLinkScope | undefined = linkClaims
    ? { toolScope: installed.ui.toolScope ?? {}, claims: linkClaims }
    : undefined
  return dispatchAllowlistedAppTool(installed.ui.tools ?? [], input, deps, installed.dir, linkScope)
}

/**
 * The builtin-panel twin of `performAppToolCall`, for `POST
 * /apps/:appId/tool-call` (http-server.ts) when the appId names a builtin
 * panel instead of an installed app — a builtin is never persisted to
 * `AppRegistry` (builtin-apps.ts), so there is no `installed.ui.tools` to
 * read there. The caller resolves the allowlist itself (`
 * resolveBuiltinPanelUi(appId, ...)?.tools`, builtin-apps.ts) and hands it
 * in — `tools === undefined` means "no such builtin", kept distinct from a
 * real builtin declaring an empty allowlist (`[]`, which still refuses
 * every non-discovery tool rather than 404ing). Reuses the exact same
 * enforcement + dispatch as `performAppToolCall` via
 * `dispatchAllowlistedAppTool`, so a builtin's tool-call route is exactly as
 * locked down as an installed app's.
 */
export async function performBuiltinPanelToolCall(
  tools: readonly string[] | undefined,
  input: { appId: string; tool: string; args?: Record<string, unknown> },
  deps: AppToolCallDeps,
  /** See `performAppToolCall`'s same parameter. A builtin panel never
   *  declares a `ui.toolScope` (`resolveBuiltinPanelUi` carries no such
   *  field), so a scoped call here always fails closed with "not in
   *  ui.toolScope" — there is no scope map to grant against. */
  linkClaims?: Readonly<Record<string, string>>,
): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  if (tools === undefined) {
    return errorResult(`app_tool_call: app "${input.appId}" is not installed or has no UI.`)
  }
  const linkScope: AppLinkScope | undefined = linkClaims ? { toolScope: {}, claims: linkClaims } : undefined
  return dispatchAllowlistedAppTool(tools, input, deps, undefined, linkScope)
}

/**
 * App→app calls (`app_call`) — a consumer app invokes a workflow that one of
 * its `requires.apps` entries both declares AND allowlists, on a provider
 * app that exposes that workflow.
 *
 * TRUST MODEL: the daemon is local-trust. `callerAppId` is a DECLARATION
 * check — it answers "may this consumer call that provider's workflow", not
 * "is this caller really who it says it is". Any local process that can
 * reach the daemon can name any installed callerAppId; there is no
 * isolation between apps and no authentication of the caller. The check
 * exists to enforce declared dependencies (an app can't call providers it
 * never declared, or workflows its dependency didn't allowlist), not to
 * sandbox untrusted code.
 *
 * Check order (each failure gets a distinct `errorCode`):
 *   1. caller app installed            → `caller-not-installed`
 *   2. caller declares a dependency on `appId` (requires.apps) → `not-declared`
 *   3. workflow ∈ the caller's declared `workflows` for that dependency
 *                                      → `workflow-not-allowed`
 *   4. provider app installed           → `provider-not-installed`
 *   5. workflow ∈ provider `exposes.workflows` → `workflow-not-exposed`
 *   6. provider's installed version satisfies the declared `version` range,
 *      when both are present         → `version-mismatch`
 *   7. dispatch through the SAME `workflowRunner` path `workflow_run_file`
 *      uses for a bundled WORKFLOW.md (`startFromFile` + bounded status
 *      poll) and await the result:
 *      run ended failed/cancelled      → `workflow-failed`
 *      bounded wait elapsed            → `timeout`
 */
export type AppCallErrorCode =
  | "caller-not-installed"
  | "not-declared"
  | "workflow-not-allowed"
  | "provider-not-installed"
  | "workflow-not-exposed"
  | "version-mismatch"
  | "workflow-failed"
  | "timeout"
  | "not-enabled"

export type AppCallResult =
  | { readonly ok: true; readonly output: unknown; readonly runId: string; readonly durationMs: number }
  | { readonly ok: false; readonly error: string; readonly errorCode: AppCallErrorCode }

export interface PerformAppCallDeps {
  /** The daemon's workflow runner — the same dispatch `workflow_run_file`
   *  uses for a bundled WORKFLOW.md. Omitted → `app_call` reports
   *  `not-enabled` (mirrors `app_run`'s adapter-resolver posture). */
  workflowRunner?: WorkflowRunner
}

/** Default bounded wait for a dispatched workflow run to reach a terminal
 *  status. */
export const DEFAULT_APP_CALL_TIMEOUT_MS = 60_000
/** Hard cap on `timeoutMs` — a caller cannot wait forever. */
export const MAX_APP_CALL_TIMEOUT_MS = 300_000
/** Poll interval while awaiting a run's terminal status. */
const APP_CALL_POLL_INTERVAL_MS = 500

/** `versionSatisfies` throws on a malformed version or range; a refusal is a
 *  result, never an exception. A missing provider version fails closed. */
function checkVersion(providerVersion: string | undefined, range: string): string | undefined {
  if (providerVersion === undefined) return "has no recorded version"
  try {
    return versionSatisfies(providerVersion, range) ? undefined : `is installed at version ${providerVersion}`
  } catch (err) {
    return `has an unusable version (${err instanceof Error ? err.message : String(err)})`
  }
}

function appCallLog(input: { callerAppId: string; appId: string; workflow: string }, durationMs: number, ok: boolean): void {
  console.error(
    `app_call: caller=${input.callerAppId} provider=${input.appId} workflow=${input.workflow} durationMs=${durationMs} ok=${ok}`,
  )
}

export async function performAppCall(
  appRegistry: AppRegistry,
  input: { callerAppId: string; appId: string; workflow: string; input?: unknown; timeoutMs?: number },
  deps: PerformAppCallDeps,
): Promise<AppCallResult> {
  // 1. The caller must be an installed app.
  const caller = appRegistry.getApp(input.callerAppId)
  if (!caller) {
    return {
      ok: false,
      errorCode: "caller-not-installed",
      error: `app_call: caller app "${input.callerAppId}" is not installed.`,
    }
  }
  // 2. The caller must declare a dependency on the provider (requires.apps,
  //    either entry form — both normalize onto `requiresApps`).
  const declared = caller.requiresApps?.find(e => e.id === input.appId)
  if (!declared) {
    return {
      ok: false,
      errorCode: "not-declared",
      error:
        `app_call: app "${input.callerAppId}" does not declare a dependency on "${input.appId}" ` +
        `(requires.apps).`,
    }
  }
  // 3. The workflow must be in the caller's declared allowlist for that
  //    dependency. Omitted/empty `workflows` = dependency only, no calls.
  if (declared.workflows === undefined || !declared.workflows.includes(input.workflow)) {
    return {
      ok: false,
      errorCode: "workflow-not-allowed",
      error:
        `app_call: app "${input.callerAppId}"'s dependency on "${input.appId}" does not allow ` +
        `calling workflow "${input.workflow}"${declared.workflows !== undefined ? ` (allowed: ${declared.workflows.join(", ") || "none"})` : ""}.`,
    }
  }
  // 4. The provider must be installed.
  const provider = appRegistry.getApp(input.appId)
  if (!provider) {
    return {
      ok: false,
      errorCode: "provider-not-installed",
      error: `app_call: provider app "${input.appId}" is not installed.`,
    }
  }
  // 5. The provider must expose the workflow.
  if (!provider.exposes?.workflows.includes(input.workflow)) {
    return {
      ok: false,
      errorCode: "workflow-not-exposed",
      error:
        `app_call: app "${input.appId}" does not expose workflow "${input.workflow}" ` +
        `(exposes.workflows: ${provider.exposes?.workflows.join(", ") || "none"}).`,
    }
  }
  // 6. The provider's installed version must satisfy the declared range.
  if (declared.version !== undefined) {
    const problem = checkVersion(provider.version, declared.version)
    if (problem !== undefined) {
      return {
        ok: false,
        errorCode: "version-mismatch",
        error:
          `app_call: app "${input.appId}" ${problem}, which does not ` +
          `satisfy the range "${declared.version}" app "${input.callerAppId}" declared.`,
      }
    }
  }

  const runner = deps.workflowRunner
  if (!runner) {
    return {
      ok: false,
      errorCode: "not-enabled",
      error:
        "app_call is not enabled — the daemon was started without a workflow runner. " +
        "Re-run the daemon with the `@agentproto/cli` shim wired (see playground/scripts/gateway.ts).",
    }
  }

  // 7. Dispatch through the same runner path `workflow_run_file` uses for a
  //    bundled WORKFLOW.md, then await the run's terminal status under a
  //    bounded timeout.
  const startedAt = Date.now()
  const ref = provider.workflows.find(w => w.id === input.workflow)
  if (!ref) {
    return {
      ok: false,
      errorCode: "workflow-not-exposed",
      error: `app_call: app "${input.appId}" exposes workflow "${input.workflow}" but does not bundle it.`,
    }
  }
  let run: Awaited<ReturnType<typeof runner.startFromFile>>
  try {
    run = await runner.startFromFile({ path: ref.path, input: input.input, appId: provider.appId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    appCallLog(input, Date.now() - startedAt, false)
    return {
      ok: false,
      errorCode: "workflow-failed",
      error: `app_call: could not start workflow "${input.workflow}" on "${input.appId}": ${message}`,
    }
  }
  const timeoutMs = Math.min(Math.max(1, input.timeoutMs ?? DEFAULT_APP_CALL_TIMEOUT_MS), MAX_APP_CALL_TIMEOUT_MS)
  for (;;) {
    const status = runner.status(run.runId)
    if (status !== undefined && (status.status === "done" || status.status === "failed" || status.status === "cancelled")) {
      const durationMs = Date.now() - startedAt
      if (status.status !== "done") {
        appCallLog(input, durationMs, false)
        return {
          ok: false,
          errorCode: "workflow-failed",
          error:
            `app_call: workflow "${input.workflow}" on "${input.appId}" ended ${status.status}` +
            `${status.error !== undefined ? `: ${status.error}` : ""}.`,
        }
      }
      appCallLog(input, durationMs, true)
      const output = runner.status(run.runId, { resolveOutputs: true })?.output ?? status.output
      return { ok: true, output, runId: run.runId, durationMs }
    }
    if (Date.now() - startedAt >= timeoutMs) {
      const durationMs = Date.now() - startedAt
      appCallLog(input, durationMs, false)
      return {
        ok: false,
        errorCode: "timeout",
        error: `app_call: workflow "${input.workflow}" on "${input.appId}" did not finish within ${timeoutMs}ms (run ${run.runId} still ${status?.status ?? "unknown"}).`,
      }
    }
    await new Promise(resolve => setTimeout(resolve, APP_CALL_POLL_INTERVAL_MS))
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
    readonly frameDomains?: readonly string[]
  }
  readonly build?: AppUiBuildConfig
  /** Raw APP.md `ui.extensions` frontmatter — structurally preserved here;
   *  the normalized OpenAI projection (`handle.ui.extensions`, already
   *  validated by app-kit) is what actually persists. */
  readonly extensions?: { readonly openai?: OpenAIAppUiExtension }
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
): Promise<{ agents: InstalledAppRef[]; workflows: InstalledAppRef[]; ui?: AppRefsUi; artifact?: AppRefsArtifact; skill?: AppRefsSkill; services?: unknown }> {
  const appPath = join(dir, ".agentproto", "APP.md")
  const source = await readFile(appPath, "utf8")
  const { data } = matter(source) as { data: { agents?: unknown; workflows?: unknown; ui?: unknown; artifact?: unknown; skill?: unknown; services?: unknown } }
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
  return { agents: toRefs(data.agents), workflows: toRefs(data.workflows), ...(ui ? { ui } : {}), ...(artifact ? { artifact } : {}), ...(skill ? { skill } : {}), ...(data.services !== undefined ? { services: data.services } : {}) }
}

export interface RegisterAppToolsOptions {
  /** The daemon's own workspace root — hidden from `app_run` sessions (see
   *  `app-boundary.ts`). */
  daemonWorkspace?: string
  /** The daemon's own plain `/mcp` gateway URL — lets an `app_run` session
   *  get the gateway mount `agent_start` gives (scoped to the agent's
   *  declared tools, see `SpawnAgentSessionInput.allowTools`). Omitted ⇒ no
   *  gateway mount, and declared tools are reported as not applied. */
  daemonMcpUrl?: string
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
  /** Resolves an AGENT.md `model: role:<name>` at `app_run` time. */
  resolveModelRole?: ModelRoleResolver
  /** When wired, `app_status` folds in workflow runs whose `workflowId`
   *  belongs to the app — any run of one of its bundled WORKFLOW.md files,
   *  however it was started (`workflow_run_file`, `workflow_start`, …).
   *  Omitted → `app_status` reports sessions only. */
  workflowRunner?: WorkflowRunner
  /** `workspaces.json` that app-owned workspaces (`app-<slug>`) are registered
   *  in at install and removed from at uninstall. Defaults to
   *  `~/.agentproto/workspaces.json`. */
  workspacesConfigPath?: string
  /** Absolute path for the persistence file. Defaults to `~/.agentproto/apps.json`. */
  persistPath?: string
  /** Service-owner ownership store (Pygmalion phase 1b item 2). Defaults to
   *  `app-services.json` beside `persistPath` (`~/.agentproto/app-services.json`
   *  in the daemon). Tests inject their own to inspect/seed owner records. */
  serviceStore?: AppServiceStore
  /** Overrides the service-owner store's persistence path (ignored when
   *  `serviceStore` is supplied). */
  serviceStorePath?: string
  /** Spawn seam for a service owner. Defaults to `spawnAgentSession` with
   *  `keepAlive` + `restartPolicy` (see `defaultSpawnServiceOwner` inside
   *  `registerAppTools`); tests inject a stub. */
  spawnServiceOwner?: SpawnServiceOwner
  /** Adapter slug a service owner spawns under. Defaults to `"pi"` — the same
   *  adapter `agent_start` defaults to when the caller names none. */
  serviceAdapter?: string
  /** Kill seam for an uninstalled/replaced service owner. Defaults to
   *  `registry.kill(sessionId)` + `killServicePid(pid)`; tests inject a spy. */
  killServiceOwner?: (owner: AppServiceOwner) => void | Promise<void>
  /** Root for remote-installed apps (`<appsDir>/<slug>`, `app_install {url|file}`).
   *  Defaults to `apps/` next to `persistPath` (the daemon state dir). */
  appsDir?: string
  /** Enable filesystem persistence. Defaults to `true` when `persistPath` is
   *  explicitly supplied, `false` otherwise — mirrors workflow-runner.ts. */
  persist?: boolean
  /** Sequential-run termination waiter — awaited after each `sequence` agent
   *  spawn so the next agent only starts once the previous is done. Defaults
   *  to `waitForSessionTerminal`'s bounded poll (up to 60 × 2s). Tests inject
   *  a stub to drive session termination deterministically without sleeping. */
  waitForSessionTerminal?: (sessionId: string) => Promise<void>
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
  /** Remote-catalog fetcher (5 min in-memory cache + disk cache under
   *  `catalogCacheDir`). Defaults to a fresh client per `registerAppTools`
   *  call; tests inject one. */
  remoteCatalog?: RemoteCatalogClient
  /** Loads the daemon config for `catalog.sources`. Defaults to `loadConfig`. */
  loadCatalogConfig?: () => Promise<{ catalog?: CatalogConfig }>
  /** Disk cache for remote catalogs (last good copy per source). Defaults to
   *  `<dir of apps.json>/cache/catalog` (`~/.agentproto/cache/catalog`). */
  catalogCacheDir?: string
  /** Offline fallback for the default catalog source. Defaults to the
   *  embedded `FIRST_PARTY_CATALOG_ENTRIES`; tests inject their own. */
  fallbackCatalogEntries?: readonly AppCatalogEntry[]
}

/** Expand a leading `~` (bare or `~/…`) against `os.homedir()`. Any other
 *  string passes through untouched — `resolve()` below handles relative
 *  segments. */
function expandHome(raw: string): string {
  if (raw === "~") return homedir()
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2))
  return raw
}

/**
 * Normalize `handle.externalReadRoots` (declared in APP.md frontmatter /
 * `defineApp()`) into absolute, `~`-expanded paths, and fail fast — rather
 * than storing a bad root — if any entry doesn't exist as a real directory
 * at install time. This is the only place these roots are ever written to
 * an `InstalledApp` record; `app_external_list`/`app_external_read`
 * (app-external.ts) and the `GET /apps/:appId/external-blob` HTTP route
 * trust `InstalledApp.externalReadRoots` as already-validated.
 */
async function normalizeExternalReadRoots(
  roots: readonly string[],
): Promise<{ ok: true; roots: string[] } | { ok: false; error: string }> {
  const normalized: string[] = []
  for (const raw of roots) {
    const abs = resolve(expandHome(raw))
    let st: Awaited<ReturnType<typeof stat>>
    try {
      st = await stat(abs)
    } catch (err) {
      return {
        ok: false,
        error: `externalReadRoots entry "${raw}" (resolved "${abs}") does not exist: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (!st.isDirectory()) {
      return {
        ok: false,
        error: `externalReadRoots entry "${raw}" (resolved "${abs}") is not a directory.`,
      }
    }
    normalized.push(abs)
  }
  return { ok: true, roots: normalized }
}

export interface PerformInstallOptions {
  /** Explicit data root for the `app_data_*` plane. Absolute or `~`-relative;
   *  a relative path is taken relative to the app dir (like the APP.md
   *  `data.dir` hint). Wins over every other source. */
  readonly dataDir?: string
  /** Provenance recorded on the installed-app record (remote installs). */
  readonly source?: AppSource
  /** May `performInstall` run the APP.md `ui.build` command (and persist it
   *  so later UI requests may re-run it)? Default true — a local `{dir}`
   *  install is the user's own code. Remote installs pass false unless the
   *  caller opted in (`app_install {url, allowBuild: true}` for git; never
   *  for a `.agentapp`): the bundle must then already be on disk, and
   *  `ui.build` is dropped from the persisted record so no later request
   *  (`GET /apps/:id/ui`, the MCP panel cache) runs it either. */
  readonly allowUiBuild?: boolean
  /** Last-resort data root when no explicit, previous or APP.md-hinted
   *  `dataDir` applies — remote installs pass `<state dir>/app-data/<id>` so
   *  data never lands in their replaceable code dir. Absent = `<dir>/data`. */
  readonly defaultDataDir?: (appId: string) => string
  /** Catalog this remote install comes from (`app_install {catalogUrl}`):
   *  recorded as `source.catalogId = {url, appId}` so `app_updates` /
   *  `app_resync` follow that catalog's entry. Ignored for a local source. */
  readonly catalogUrl?: string
  /** Skip the two checks that need a running daemon — every `tool` step id is
   *  a registered daemon tool, and the default agent adapter resolves. For
   *  `agentproto app install <dir>` with no daemon up: the record written is
   *  otherwise identical to the one `app_install {dir}` writes, and those two
   *  checks are redone by whoever runs the app. */
  readonly skipDaemonChecks?: boolean
  /** `workspaces.json` the app-owned workspace is registered in. Default `~/.agentproto/workspaces.json`. */
  readonly workspacesConfigPath?: string
  /**
   * Service-owner launcher (frozen `services:` semantics). Called after the
   * record is upserted and the app workspace registered, once per install,
   * for an app whose manifest declares `services`. Omitted ⇒ a `services:`
   * block is validated but no owners are spawned (e.g. the offline CLI
   * install, which has no daemon to spawn sessions on). The callback is
   * itself idempotent (`ensureAppServiceOwners`) so a reinstall does not
   * spawn a duplicate owner for a service already alive.
   */
  readonly ensureServices?: (input: {
    app: InstalledApp
    dir: string
    services: readonly AppService[]
    /** Boot mode: treat every recorded owner as stale and replace it (see
     *  `reensureAppServiceOwners`), instead of keeping a live one. Omitted by
     *  every install path; set only by the boot re-ensure. */
    force?: boolean
  }) => Promise<EnsureAppServiceOwnersResult>
}

/**
 * Resolve the data root persisted on the `InstalledApp` record (see
 * `InstalledApp.dataDir`). Precedence: explicit `opts.dataDir` > the
 * previously persisted `dataDir` of the same appId (so a bare re-install
 * never silently moves an app's data) > the APP.md `data.dir` hint > the caller's
 * `fallback` (remote installs: `<state dir>/app-data/<id>`) > `<dir>/data`.
 * Always absolute. A path that exists but is not a directory
 * is rejected; a missing one is fine — `app_data_write` creates it lazily.
 */
export async function resolveInstallDataDir(input: {
  dir: string
  explicit?: string
  previous?: string
  hint?: string
  fallback?: string
}): Promise<{ ok: true; dataDir: string } | { ok: false; error: string }> {
  const raw = input.explicit ?? input.previous ?? input.hint
  const dataDir =
    raw !== undefined
      ? resolve(input.dir, expandHome(raw))
      : input.fallback !== undefined
        ? resolve(input.fallback)
        : resolve(input.dir, DEFAULT_APP_DATA_SUBDIR)
  try {
    const st = await stat(dataDir)
    if (!st.isDirectory()) {
      return { ok: false, error: `dataDir "${dataDir}" exists but is not a directory.` }
    }
  } catch {
    // Missing is fine — created on first write.
  }
  return { ok: true, dataDir }
}

export async function performInstall(
  dir: string,
  appRegistry: AppRegistry,
  listRegisteredToolIds: () => Promise<string[]>,
  resolveAgentAdapter?: AgentAdapterResolver,
  opts?: PerformInstallOptions,
): Promise<{ ok: true; record: Awaited<ReturnType<typeof appRegistry.upsertApp>> } | { ok: false; error: string }> {
  // `loadAppHandle` reads `ui.path` eagerly and throws when it's missing —
  // exactly the case a declared `ui.build` exists to recover from. Peek the
  // frontmatter first (no html read) and build BEFORE the real load, so a
  // missing-but-buildable bundle installs instead of failing.
  let uiPeek: Awaited<ReturnType<typeof peekAppUi>>
  try {
    uiPeek = await peekAppUi(dir)
  } catch (err) {
    return { ok: false, error: `${err instanceof Error ? err.message : String(err)}` }
  }
  const allowUiBuild = opts?.allowUiBuild !== false
  if (uiPeek) {
    if (uiPeek.build !== undefined && !allowUiBuild) {
      let present = false
      try {
        present = (await stat(uiPeek.path)).isFile()
      } catch {
        present = false
      }
      if (!present) {
        return {
          ok: false,
          error:
            `app_install: this app's UI bundle "${uiPeek.path}" is missing and would have to be built by ` +
            `running \`${uiPeek.build.command}\` from the downloaded sources. The daemon does not run build ` +
            "commands from remote sources by default: re-run with allowBuild: true (CLI: --allow-build) " +
            "for a git URL you trust. A .agentapp never runs ui.build — ship it with the UI prebuilt " +
            "(`agentproto app pack --release`).",
        }
      }
    } else {
      const ensured = await ensureAppUiBuilt({ dir, uiPath: uiPeek.path, build: uiPeek.build })
      if (!ensured.ok) return { ok: false, error: `app_install: ${ensured.error}` }
    }
  }

  let handle: Awaited<ReturnType<typeof loadAppHandle>>
  try {
    handle = await loadAppHandle(dir)
  } catch (err) {
    return { ok: false, error: `${err instanceof Error ? err.message : String(err)}` }
  }

  if (!handle.id) {
    return { ok: false, error: "the app has no `id` — set one in defineApp()/APP.md frontmatter to install it." }
  }

  // A workflow `tool` step id is satisfied by either a registered daemon
  // tool OR one of the app's OWN bundled TOOL.md ids (BRIEF-D) — the same
  // id-coverage `mergeAppAndDaemonToolRegistry` applies at compile time
  // (workflow-tool-registry.ts), checked here with just the id set since
  // install-time validation doesn't need live driver dispatch.
  const skipDaemonChecks = opts?.skipDaemonChecks === true
  const appToolIds = new Set(handle.tools.map(t => t.id))
  const missingByWorkflow: Record<string, string[]> = {}
  const registeredIds = new Set(skipDaemonChecks ? [] : await listRegisteredToolIds())
  for (const workflow of skipDaemonChecks ? [] : handle.workflows) {
    const { tools } = createDaemonToolRegistry(workflow, async () => undefined)
    const missing = Object.keys(tools).filter(id => !registeredIds.has(id) && !appToolIds.has(id))
    if (missing.length > 0) missingByWorkflow[workflow.id] = missing
  }
  if (Object.keys(missingByWorkflow).length > 0) {
    return {
      ok: false,
      error: `unknown daemon tool id(s) referenced by workflow step(s) — would otherwise fail at STEP-DISPATCH time: ${JSON.stringify(missingByWorkflow)}`,
    }
  }

  if (handle.agents.length > 0 && !skipDaemonChecks) {
    const resolved = resolveAgentAdapter ? await resolveAgentAdapter(DEFAULT_AGENT_ADAPTER) : null
    if (!resolved) {
      return {
        ok: false,
        error: `agent adapter "${DEFAULT_AGENT_ADAPTER}" could not be resolved — run \`agentproto install ${DEFAULT_AGENT_ADAPTER}\` first.`,
      }
    }
  }

  const refs = await readAppRefs(dir)
  // Frozen `services:` semantics — validated here so a malformed block fails
  // the install instead of launching a partial service set. Absent = the
  // no-op case (the launcher below never fires for an app without services).
  const parsedServices = parseAppServices(refs.services)
  if (parsedServices.errors.length > 0) {
    return { ok: false, error: `invalid services declaration — ${parsedServices.errors.join("; ")}` }
  }
  const unvalidatedAgentTools = [
    ...new Set(handle.agents.flatMap(e => (e.agent.tools ?? []).map(refIdOf))),
  ]

  const ui = refs.ui
    ? {
        path: refs.ui.path,
        ...(handle.ui?.title !== undefined ? { title: handle.ui.title } : {}),
        ...(handle.ui?.description !== undefined ? { description: handle.ui.description } : {}),
        ...(handle.ui?.tools !== undefined ? { tools: handle.ui.tools } : {}),
        ...(handle.ui?.toolScope !== undefined ? { toolScope: handle.ui.toolScope } : {}),
        ...(handle.ui?.csp !== undefined ? { csp: handle.ui.csp } : {}),
        ...(handle.ui?.build !== undefined && allowUiBuild ? { build: handle.ui.build } : {}),
        // OpenAI MCP-extensions carrier (plan W-B): the normalized,
        // app-kit-validated `ui.extensions` block persists verbatim on the
        // installed record — `makeInstalledAppUiApps` (W-C) is the only
        // consumer. Frozen already by app-kit; spread-cloned here so the
        // persisted shape stays a plain JSON-safe object (apps.json is
        // what actually freezes it). Apps without the block install
        // identically to before (plan I1).
        ...(handle.ui?.extensions !== undefined ? { extensions: handle.ui.extensions } : {}),
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

  let externalReadRoots: string[] | undefined
  if (handle.externalReadRoots && handle.externalReadRoots.length > 0) {
    const result = await normalizeExternalReadRoots(handle.externalReadRoots)
    if (!result.ok) return { ok: false, error: `app_install: ${result.error}` }
    externalReadRoots = result.roots
  }

  const dataDirResult = await resolveInstallDataDir({
    dir,
    ...(opts?.dataDir !== undefined ? { explicit: opts.dataDir } : {}),
    ...(appRegistry.getApp(handle.id)?.dataDir !== undefined
      ? { previous: appRegistry.getApp(handle.id)!.dataDir }
      : {}),
    ...(handle.data?.dir !== undefined ? { hint: handle.data.dir } : {}),
    ...(opts?.defaultDataDir !== undefined ? { fallback: opts.defaultDataDir(handle.id) } : {}),
  })
  if (!dataDirResult.ok) return { ok: false, error: `app_install: ${dataDirResult.error}` }

  const record = appRegistry.upsertApp({
    appId: handle.id,
    dir,
    dataDir: dataDirResult.dataDir,
    ...(handle.version ? { version: handle.version } : {}),
    ...(handle.name ? { name: handle.name } : {}),
    ...(handle.description ? { description: handle.description } : {}),
    agents: refs.agents,
    workflows: refs.workflows,
    unvalidatedAgentTools,
    ...(handle.requires ? { requires: handle.requires } : {}),
    ...(handle.appRequirements.length > 0 ? { requiresApps: handle.appRequirements } : {}),
    ...(handle.exposes.agents.length > 0 || handle.exposes.workflows.length > 0
      ? { exposes: handle.exposes }
      : {}),
    ...(ui ? { ui } : {}),
    ...(artifact ? { artifact } : {}),
    ...(skill ? { skill } : {}),
    ...(handle.artifacts ? { artifacts: handle.artifacts } : {}),
    ...(handle.dev ? { dev: handle.dev } : {}),
    ...(externalReadRoots ? { externalReadRoots } : {}),
    ...(handle.boundaries ? { boundaries: { ...handle.boundaries } } : {}),
    ...(opts?.source !== undefined
      ? {
          source:
            opts.catalogUrl !== undefined && opts.source.kind !== "local"
              ? { ...opts.source, catalogId: { url: opts.catalogUrl, appId: handle.id } }
              : opts.source,
        }
      : {}),
  })

  await registerAppWorkspace({
    appId: record.appId,
    dir,
    workspace: handle.workspace,
    ...(opts?.workspacesConfigPath !== undefined ? { configPath: opts.workspacesConfigPath } : {}),
  })

  // Service-owner launch (frozen `services:` semantics, Phase 1b item 2).
  // Runs AFTER the record + workspace exist; idempotent and best-effort — a
  // service that fails to spawn is reported, never fails the install. An app
  // without `services` skips this entirely (byte-for-byte unchanged).
  if (parsedServices.services.length > 0 && opts?.ensureServices) {
    try {
      await opts.ensureServices({ app: record, dir, services: parsedServices.services })
    } catch (err) {
      console.warn(
        `[app-services] could not launch service owners for "${record.appId}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return { ok: true, record }
}

/**
 * Re-resolve every `incomplete` registry record (a partial record written by
 * an older/foreign writer — see `normalizeInstalledApp`) from its app dir, so
 * it carries the full agents/workflows/ui refs again. The previous `dataDir`
 * is kept (`performInstall` prefers it). A record whose dir is gone, or that
 * no longer installs, stays flagged in `listIssues()` with the reason.
 * Returns the app ids that were repaired.
 */
export async function repairIncompleteApps(
  appRegistry: AppRegistry,
  listRegisteredToolIds: () => Promise<string[]>,
  resolveAgentAdapter?: AgentAdapterResolver,
): Promise<string[]> {
  const repaired: string[] = []
  for (const issue of appRegistry.listIssues()) {
    if (issue.kind !== "incomplete" || issue.appId === null || issue.dir === null) continue
    if (!existsSync(issue.dir)) continue
    const result = await performInstall(issue.dir, appRegistry, listRegisteredToolIds, resolveAgentAdapter, {
      skipDaemonChecks: true,
    }).catch(() => ({ ok: false as const }))
    if (result.ok && result.record.appId === issue.appId) repaired.push(issue.appId)
  }
  return repaired
}

const repairStarted = new WeakSet<AppRegistry>()

/** Result of the boot-time app-service re-ensure (`reensureInstalledAppServicesOnBoot`). */
export interface AppServiceBootReensureResult {
  /** Installed apps that declared a non-empty `services:` block. */
  apps: number
  /** Owners freshly spawned across those apps. */
  spawned: number
  /** Per-service failures, `"<appId>:<name>: <error>"` — surfaced, never thrown. */
  errors: string[]
}

/** Everything `buildAppServiceEnsurer` needs to spawn/kill service owners —
 *  all of it available where a gateway is built. */
export interface AppServiceEnsurerDeps {
  registry: SessionsRegistry
  serviceStore: AppServiceStore
  resolveAgentAdapter?: AgentAdapterResolver
  daemonMcpUrl?: string
  serviceAdapter?: string
  workspacesConfigPath?: string
  spawnServiceOwner?: SpawnServiceOwner
  killServiceOwner?: (owner: AppServiceOwner) => void | Promise<void>
}

/**
 * Build the `ensureServices` callback `app_install` runs (frozen `services:`
 * semantics). Extracted to module scope so the boot re-ensure
 * (`reensureInstalledAppServicesOnBoot`) reuses the exact same spawn/kill
 * wiring — `registerAppTools` runs per `/mcp` request (stateless pattern), so
 * a handle returned from it is not a boot singleton.
 */
export function buildAppServiceEnsurer(
  deps: AppServiceEnsurerDeps,
): NonNullable<PerformInstallOptions["ensureServices"]> {
  const serviceAdapter = deps.serviceAdapter ?? "pi"

  /** The default spawn: the SAME infra as agents (`spawnAgentSession`), with
   *  `keepAlive` (exempt from the idle-reaper) + a `restartPolicy` (the daemon
   *  revives the owner if the adapter process crashes). The owner's own prompt
   *  supervises the `entry` child — there is no scheduler. */
  const defaultSpawnServiceOwner = async (input: {
    appId: string
    dir: string
    service: AppService
    workspaceSlug?: string
    stateDir: string
  }): Promise<SpawnServiceOwnerResult> => {
    const resolveAgentAdapter = deps.resolveAgentAdapter
    if (!resolveAgentAdapter) {
      return { ok: false, error: "no adapter resolver is wired — cannot spawn a service owner" }
    }
    const result = await spawnAgentSession(
      {
        registry: deps.registry,
        resolveAgentAdapter,
        ...(deps.daemonMcpUrl !== undefined ? { daemonMcpUrl: deps.daemonMcpUrl } : {}),
      },
      {
        adapter: serviceAdapter,
        cwd: input.dir,
        ...(input.workspaceSlug !== undefined ? { workspaceSlug: input.workspaceSlug } : {}),
        prompt: buildServiceOwnerPrompt(input.service, servicePidFilePath(input.stateDir, input.service.name)),
        label: serviceOwnerLabel(input.appId, input.service.name),
        appId: input.appId,
        keepAlive: true,
        restartPolicy: {
          on: ["crashed", "error"],
          maxRetries: 5,
          windowMs: 10 * 60 * 1000,
          baseDelayMs: 5_000,
          factor: 2,
          maxDelayMs: 60_000,
        },
      },
    )
    if (!result.ok) return { ok: false, error: result.message }
    return {
      ok: true,
      sessionId: result.descriptor.id,
      ...(result.descriptor.pid !== null && result.descriptor.pid !== undefined
        ? { pid: result.descriptor.pid }
        : {}),
    }
  }

  /** Kill seam: the owner SESSION + the recorded process pid. */
  const killServiceOwner = (owner: AppServiceOwner): void => {
    deps.registry.kill(owner.sessionId)
    killServicePid(owner.pid)
  }

  return async ({ app, dir, services, force }) => {
    const workspaceSlug = await ensureAppWorkspace({
      appId: app.appId,
      dir,
      ...(deps.workspacesConfigPath !== undefined ? { configPath: deps.workspacesConfigPath } : {}),
    })
    const stateDir = app.stateDir ?? app.dataDir ?? dir
    const spawnOwner: SpawnServiceOwner =
      deps.spawnServiceOwner ?? (input => defaultSpawnServiceOwner({ ...input, stateDir }))
    const spawn = (service: AppService): Promise<SpawnServiceOwnerResult> =>
      spawnOwner({
        appId: app.appId,
        dir,
        service,
        ...(workspaceSlug !== undefined ? { workspaceSlug } : {}),
      })
    const killOwner = deps.killServiceOwner ?? killServiceOwner
    const result =
      force === true
        ? await reensureAppServiceOwners({
            store: deps.serviceStore,
            appId: app.appId,
            services,
            stateDir,
            spawn,
            killOwner,
          })
        : await ensureAppServiceOwners({
            store: deps.serviceStore,
            appId: app.appId,
            services,
            isOwnerAlive: owner => {
              const desc = deps.registry.get(owner.sessionId)
              return desc !== undefined && !isSessionTerminal(desc.status)
            },
            spawn,
            killOwner,
          })
    for (const e of result.errors) {
      console.warn(`[app-services] service "${app.appId}:${e.name}" not started: ${e.error}`)
    }
    return result
  }
}

/**
 * Boot re-ensure of app-service owners (Pygmalion phase 1b item 2).
 * `app_install`'s `ensureServices` runs only on the install path, so a service
 * whose owner died with the previous daemon stays down until the next
 * reinstall. This force-replaces every recorded owner for every installed app
 * that declares `services:` (see `reensureAppServiceOwners` for why force, not
 * an `isOwnerAlive` check). Best-effort: a per-app failure is collected, never
 * thrown. The daemon boot path (serve.ts) calls this AFTER the session resume
 * passes, so it never races them for an owner session id.
 *
 * Deliberately NOT bucket-scoped, unlike the three sibling boot passes it
 * runs after (`reattachSandboxSessionsOnBoot` / `resumeSessionsOnBoot` /
 * `continueInterruptedOnBoot`, each threading an `isServed` predicate so a
 * daemon never touches another bucket's sessions): `deps.appRegistry` (the
 * installed-app registry, `~/.agentproto/apps.json`) and the app-service
 * store (`~/.agentproto/app-services.json`) carry no workspace/bucket field
 * to filter on — `InstalledApp` never has, and `ensureServices` already
 * iterates every installed app unfiltered on the pre-existing `app_install`
 * path this re-ensure mirrors. Apps and their declared services are
 * machine-global, single-daemon-owned state; running two daemons for
 * different buckets of the SAME machine against the same shared apps.json
 * would double-own a service's owner regardless of this pass.
 */
export async function reensureInstalledAppServicesOnBoot(
  deps: AppServiceEnsurerDeps & { appRegistry: AppRegistry },
): Promise<AppServiceBootReensureResult> {
  const ensureServices = buildAppServiceEnsurer(deps)
  let apps = 0
  let spawned = 0
  const errors: string[] = []
  for (const app of deps.appRegistry.listApps()) {
    let services: readonly AppService[]
    try {
      services = parseAppServices((await readAppRefs(app.dir)).services).services
    } catch {
      // Unreadable APP.md (dir moved/removed) — not this pass's job to repair.
      continue
    }
    if (services.length === 0) continue
    apps += 1
    try {
      const result = await ensureServices({ app, dir: app.dir, services, force: true })
      spawned += result.spawned.length
      for (const e of result.errors) errors.push(`${app.appId}:${e.name}: ${e.error}`)
    } catch (err) {
      errors.push(`${app.appId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { apps, spawned, errors }
}

export function registerAppTools(
  server: McpServer,
  opts: RegisterAppToolsOptions,
): void {
  const { registry, resolveAgentAdapter, listRegisteredToolIds, workflowRunner, dispatchTool, callImportedTool, resolveModelRole } =
    opts
  const appRegistry: AppRegistry = opts.appRegistry ?? createAppRegistry({
    ...(opts.persistPath !== undefined ? { persistPath: opts.persistPath } : {}),
    ...(opts.persist !== undefined ? { persist: opts.persist } : {}),
  })

  // Once per registry (this runs per MCP server instance): heal partial
  // records from disk without blocking the first request.
  if (!repairStarted.has(appRegistry) && appRegistry.listIssues().some(i => i.kind === "incomplete")) {
    repairStarted.add(appRegistry)
    void repairIncompleteApps(appRegistry, listRegisteredToolIds, resolveAgentAdapter).catch(() => {})
  }

  const appsDir =
    opts.appsDir ?? join(dirname(opts.persistPath ?? join(homedir(), ".agentproto", "apps.json")), "apps")

  const catalogCacheDir =
    opts.catalogCacheDir ??
    join(dirname(opts.persistPath ?? join(homedir(), ".agentproto", "apps.json")), "cache", "catalog")
  const remoteCatalog = opts.remoteCatalog ?? createRemoteCatalogClient({ cacheDir: catalogCacheDir })
  const loadCatalogConfig = opts.loadCatalogConfig ?? (() => loadConfig())
  const fallbackCatalogEntries = opts.fallbackCatalogEntries ?? FIRST_PARTY_CATALOG_ENTRIES

  // ── service owners (Pygmalion phase 1b item 2) ──────────────────────────
  const serviceStore: AppServiceStore =
    opts.serviceStore ??
    createAppServiceStore({
      ...(opts.serviceStorePath !== undefined
        ? { persistPath: opts.serviceStorePath }
        : opts.persistPath !== undefined
          ? { persistPath: join(dirname(opts.persistPath), "app-services.json") }
          : {}),
      ...(opts.persist !== undefined ? { persist: opts.persist } : {}),
    })

  const ensureServices: NonNullable<PerformInstallOptions["ensureServices"]> = buildAppServiceEnsurer({
    registry,
    serviceStore,
    ...(resolveAgentAdapter ? { resolveAgentAdapter } : {}),
    ...(opts.daemonMcpUrl !== undefined ? { daemonMcpUrl: opts.daemonMcpUrl } : {}),
    ...(opts.serviceAdapter !== undefined ? { serviceAdapter: opts.serviceAdapter } : {}),
    ...(opts.workspacesConfigPath !== undefined ? { workspacesConfigPath: opts.workspacesConfigPath } : {}),
    ...(opts.spawnServiceOwner ? { spawnServiceOwner: opts.spawnServiceOwner } : {}),
    ...(opts.killServiceOwner ? { killServiceOwner: opts.killServiceOwner } : {}),
  })

  /** Kill seam for `app_uninstall` below: the owner SESSION + the recorded
   *  process pid. Mirrors `buildAppServiceEnsurer`'s own default (same logic,
   *  just closed over this function's `registry` instead of `deps.registry`). */
  const killServiceOwner = (owner: AppServiceOwner): void => {
    registry.kill(owner.sessionId)
    killServicePid(owner.pid)
  }

  interface RemoteCatalogEntryRef {
    entry: AppCatalogEntry
    origin: string
    catalogUrl: string
    stale: boolean
  }

  /** Every remote catalog entry (default source, then config/file sources),
   *  in precedence order, tagged with where it came from. Never throws: a
   *  failing source becomes a warning (and its disk-cached copy, or for the
   *  default source the embedded first-party list). */
  const loadRemoteCatalogEntries = async (
    refresh: boolean,
    fileSources: readonly { url: string }[] | undefined,
  ): Promise<{ remoteEntries: RemoteCatalogEntryRef[]; warnings: string[] }> => {
    let catalogConfig: { sources?: unknown; defaultSource?: unknown } | undefined
    try {
      catalogConfig = (await loadCatalogConfig()).catalog
    } catch {
      // unreadable config → default source + the catalog file's sources
    }
    const sources = resolveCatalogSources(fileSources, catalogConfig)
    const remote =
      sources.length > 0
        ? await remoteCatalog.fetchSources(sources, { refresh })
        : { entries: [], warnings: [], bySource: [] }
    const remoteEntries: RemoteCatalogEntryRef[] = []
    ;(remote.bySource ?? []).forEach((result, i) => {
      const src = sources[i]
      if (src === undefined) return
      if (src.origin === "default" && !result.ok) {
        // Default catalog unreachable and never cached: fall back to the
        // embedded first-party list so the listing is never empty of them.
        for (const entry of fallbackCatalogEntries) {
          remoteEntries.push({ entry, origin: "embedded", catalogUrl: src.url, stale: true })
        }
        return
      }
      for (const entry of result.entries) {
        remoteEntries.push({ entry, origin: src.origin, catalogUrl: src.url, stale: result.stale })
      }
    })
    return { remoteEntries, warnings: remote.warnings }
  }

  /** Swap a staged remote tree in at `<appsDir>/<slug>` and run the normal
   *  `performInstall` on it; a failed install puts the previous tree back. */
  const installStaged = async (
    staged: StagedApp,
    dataDir?: string,
    allowBuild?: boolean,
    catalogUrl?: string,
  ): Promise<Awaited<ReturnType<typeof performInstall>>> => {
    const target = join(appsDir, staged.slug)
    const appDir = staged.subdir === "" ? target : join(target, staged.subdir)
    const previousDataDir = appRegistry.listApps().find(a => a.dir === appDir)?.dataDir
    let swap: Awaited<ReturnType<typeof swapInStaged>>
    try {
      swap = await swapInStaged({
        tmpDir: staged.tmpDir,
        target,
        ...(previousDataDir !== undefined ? { previousDataDir } : {}),
      })
    } catch (err) {
      await staged.discard()
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    let result: Awaited<ReturnType<typeof performInstall>>
    try {
      result = await performInstall(appDir, appRegistry, listRegisteredToolIds, resolveAgentAdapter, {
        ...(dataDir !== undefined ? { dataDir } : {}),
        ...(opts.workspacesConfigPath !== undefined ? { workspacesConfigPath: opts.workspacesConfigPath } : {}),
        source: staged.source,
        // Only a git source may build, and only with explicit consent.
        allowUiBuild: staged.source.kind === "git" && allowBuild === true,
        defaultDataDir: (appId: string) =>
          defaultRemoteAppDataDir(join(dirname(appsDir), APP_DATA_ROOT_SUBDIR), appId),
        ...(catalogUrl !== undefined ? { catalogUrl } : {}),
        ensureServices,
      })
    } catch (err) {
      await swap.rollback()
      throw err
    }
    if (!result.ok) {
      await swap.rollback()
      return result
    }
    await swap.commit()
    return result
  }

  const stageFromUrl = (input: { url: string; ref?: string; subdir?: string; sha?: string; sha256?: string }): Promise<StagedApp> =>
    isAgentappUrl(input.url)
      ? stageAgentApp({ appsDir, url: input.url, ...(input.sha256 !== undefined ? { expectedSha256: input.sha256 } : {}) })
      : stageGitApp({
          appsDir,
          url: input.url,
          ...(input.ref !== undefined ? { ref: input.ref } : {}),
          ...(input.subdir !== undefined ? { subdir: input.subdir } : {}),
          ...(input.sha !== undefined ? { expectedSha: input.sha } : {}),
        })

  server.tool(
    "app_install",
    "Install an @agentproto/app-kit app. Exactly one source: `{dir}` — an emitted app " +
      "directory on disk (`<dir>/.agentproto/APP.md`, see `defineApp().emit(dir)`); " +
      "`{url, ref?, subdir?}` — a git repo (shallow-cloned into `<daemon state dir>/apps/<slug>`, " +
      "the installed commit pinned in `source.sha`); `{url}` ending in `.agentapp` — a packed " +
      "bundle fetched over https/file (digest-verified, pinned in `source.sha256`); `{file}` — a " +
      "local `.agentapp` path. " +
      "Integrity: pass the expected `sha` (git commit) or `sha256` (bundle digest, as in a catalog entry) " +
      "and any mismatch is refused before anything is installed. A remote app's `ui.build` command is NOT " +
      "run unless `allowBuild: true` (git only; a `.agentapp` never builds) — without it the UI bundle must " +
      "already be in the source. " +
      "Remote installs are kept current with `app_resync`. Validates every " +
      "WORKFLOW.md `tool` step's id against the daemon's dispatchable tools (missing " +
      "ids are reported ALL at once, instead of failing one at a time at " +
      "STEP-DISPATCH time) and checks the `mastra-agent` adapter resolves. Agent-" +
      "declared tool refs (workspace tools like `read_file`) are the adapter's own " +
      "business and are never validated here — see `unvalidatedAgentTools` on the " +
      "result. Re-installing the same appId upserts (and keeps its existing " +
      "`dataDir` unless a new one is passed); a failed remote re-install leaves the " +
      "previous install untouched.",
    {
      dir: z.string().optional().describe("Absolute path to the app's directory (local install)."),
      url: z
        .string()
        .optional()
        .describe("Git URL (https://…, git@…, file://…) or a .agentapp URL (https://…/x.agentapp, file:///…/x.agentapp)."),
      ref: z.string().optional().describe("Git branch or tag to install (with a git `url`). Default: the remote HEAD."),
      subdir: z.string().optional().describe("Path of the app inside the git repo (with a git `url`). Default: the repo root."),
      file: z.string().optional().describe("Absolute path to a local .agentapp bundle."),
      sha: z.string().optional().describe("Expected git commit (full sha) for a git `url`. Install is refused on mismatch."),
      sha256: z
        .string()
        .optional()
        .describe("Expected `.agentapp` digest (manifest sha256, as in a catalog entry) for a bundle `url`/`file`. Refused on mismatch."),
      allowBuild: z
        .boolean()
        .optional()
        .describe("Git `url` only: allow running the app's APP.md `ui.build` shell command from the cloned repo. Default false."),
      catalogUrl: z
        .string()
        .optional()
        .describe(
          "Remote installs only: URL of the catalog this install comes from (the entry's `catalogUrl` in " +
            "`app_catalog`). Recorded as `source.catalogId` so `app_updates` / `app_resync` follow that catalog's entry.",
        ),
      dataDir: z
        .string()
        .optional()
        .describe(
          "Where the app's durable data (`app_data_*`) lives. Absolute or `~`-relative; a " +
            "relative path is taken relative to `dir`. Defaults to the previously installed " +
            "dataDir, else the APP.md `data.dir` hint, else `<dir>/data` (local dir install) or " +
            "`<daemon state dir>/app-data/<appId>` (git / .agentapp install).",
        ),
    },
    async rawInput => {
      const present = Object.fromEntries(Object.entries(rawInput).filter(([, v]) => v !== undefined))
      const parsed = appInstallInputSchema.safeParse(present)
      if (!parsed.success) return errorResult(`app_install: ${APP_INSTALL_EXCLUSIVE_ERROR}`)
      const input = parsed.data
      if ("dir" in input) {
        const result = await performInstall(input.dir, appRegistry, listRegisteredToolIds, resolveAgentAdapter, {
          ...(input.dataDir !== undefined ? { dataDir: input.dataDir } : {}),
          ...(opts.workspacesConfigPath !== undefined ? { workspacesConfigPath: opts.workspacesConfigPath } : {}),
          ensureServices,
        })
        if (!result.ok) return errorResult(`app_install: ${result.error}`)
        return textResult(result.record)
      }
      if ("url" in input && isAgentappUrl(input.url)) {
        if (input.ref !== undefined || input.subdir !== undefined || input.sha !== undefined) {
          return errorResult("app_install: `ref`/`subdir`/`sha` only apply to git URLs, not a .agentapp (use `sha256`).")
        }
        if (input.allowBuild !== undefined) {
          return errorResult("app_install: `allowBuild` only applies to git URLs — a .agentapp never runs ui.build.")
        }
      }
      if ("url" in input && !isAgentappUrl(input.url) && input.sha256 !== undefined) {
        return errorResult("app_install: `sha256` only applies to a .agentapp; pin a git URL with `sha`.")
      }
      let staged: StagedApp
      try {
        staged =
          "file" in input
            ? await stageAgentApp({
                appsDir,
                file: input.file,
                ...(input.sha256 !== undefined ? { expectedSha256: input.sha256 } : {}),
              })
            : await stageFromUrl(input)
      } catch (err) {
        return errorResult(`app_install: ${err instanceof Error ? err.message : String(err)}`)
      }
      const result = await installStaged(
        staged,
        input.dataDir,
        "url" in input ? input.allowBuild : undefined,
        input.catalogUrl,
      )
      if (!result.ok) return errorResult(`app_install: ${result.error}`)
      return textResult(result.record)
    },
  )

  server.tool(
    "app_resync",
    "An app installed from a catalog (`source.catalogId`) follows that catalog's current entry: a newer release (different digest/commit, version not lower) is staged from the entry's own URL and verified against its digest. " +
      "Re-check an app installed from git or a `.agentapp` against its source and reinstall it if " +
      "the source moved. Git: `git ls-remote` for the installed `ref` vs the pinned `source.sha`. " +
      "`.agentapp`: re-download and compare the bundle's verified `sha256` with the pinned one. " +
      "Returns `{changed:false}` when current, `{changed:true, from, to}` after a reinstall " +
      "(data dir kept). Apps installed from a local `dir` have no source to resync.",
    { appId: z.string() },
    async input => {
      const app = appRegistry.getApp(input.appId)
      if (!app) return errorResult(`app_resync: no installed app "${input.appId}".`)
      const source = app.source
      if (source === undefined || source.kind === "local") {
        return errorResult(
          `app_resync: app "${input.appId}" was installed from a local dir — nothing to resync (re-run app_install).`,
        )
      }
      try {
        // Catalog-tracked apps follow their catalog's entry: a versioned bundle
        // URL never changes content, so re-downloading the pinned URL alone
        // would never see a new release.
        const catalogRef = source.catalogId
        if (catalogRef !== undefined) {
          const { remoteEntries } = await loadRemoteCatalogEntries(true, (await loadAppCatalogFile(opts.catalogPath)).sources)
          const tracked = remoteEntries.find(r => r.catalogUrl === catalogRef.url && r.entry.appId === catalogRef.appId)
          if (tracked !== undefined && !tracked.stale) {
            if (!isCatalogUpdate(app, tracked.entry)) {
              return textResult({ appId: input.appId, changed: false, catalogUrl: tracked.catalogUrl })
            }
            const fromPin = source.kind === "git" ? source.sha : source.sha256
            const es = tracked.entry.source
            let catalogStaged: StagedApp
            if (es.kind === "agentapp") {
              catalogStaged = await stageAgentApp({ appsDir, url: es.url, expectedSha256: es.sha256 })
            } else if (es.kind === "git") {
              catalogStaged = await stageGitApp({
                appsDir,
                url: es.url,
                ...(es.ref !== undefined ? { ref: es.ref } : {}),
                ...(es.subdir !== undefined ? { subdir: es.subdir } : {}),
                expectedSha: es.sha,
              })
            } else {
              return errorResult(`app_resync: catalog entry for "${input.appId}" has no remote source.`)
            }
            const updated = await installStaged(
              catalogStaged,
              undefined,
              source.kind === "git" && app.ui?.build !== undefined,
              catalogRef.url,
            )
            if (!updated.ok) return errorResult(`app_resync: ${updated.error}`)
            const nextPin = updated.record.source
            return textResult({
              appId: updated.record.appId,
              changed: true,
              from: fromPin,
              to: nextPin?.kind === "git" ? nextPin.sha : nextPin?.kind === "agentapp" ? nextPin.sha256 : fromPin,
              catalogUrl: tracked.catalogUrl,
              ...(updated.record.version !== undefined ? { version: updated.record.version } : {}),
            })
          }
          // Catalog unreachable/stale or entry gone: fall back to the pinned source below.
        }
        let staged: StagedApp
        let from: string
        if (source.kind === "git") {
          from = source.sha
          const remote = await remoteGitSha(source.url, source.ref)
          if (remote === source.sha) return textResult({ appId: input.appId, changed: false })
          staged = await stageGitApp({
            appsDir,
            url: source.url,
            ...(source.ref !== undefined ? { ref: source.ref } : {}),
            ...(source.subdir !== undefined ? { subdir: source.subdir } : {}),
          })
        } else {
          from = source.sha256
          staged = await stageAgentApp({ appsDir, url: source.url })
          if (staged.source.kind === "agentapp" && staged.source.sha256 === source.sha256) {
            await staged.discard()
            return textResult({ appId: input.appId, changed: false })
          }
        }
        // A git app keeps building only if it was installed with consent —
        // recorded as `ui.build` surviving on the record (performInstall drops
        // it otherwise). A bundle never builds.
        const result = await installStaged(
          staged,
          undefined,
          source.kind === "git" && app.ui?.build !== undefined,
          source.catalogId?.url,
        )
        if (!result.ok) return errorResult(`app_resync: ${result.error}`)
        const next = result.record.source
        const to = next?.kind === "git" ? next.sha : next?.kind === "agentapp" ? next.sha256 : from
        return textResult({ appId: result.record.appId, changed: true, from, to })
      } catch (err) {
        return errorResult(`app_resync: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  )

  server.tool(
    "app_updates",
    "Check installed apps that came from a catalog (`app_install {catalogUrl}`, recorded as " +
      "`source.catalogId`) against that catalog's current entry, without installing anything. " +
      "Returns `{ updates: [{appId, from, to, catalogUrl, stale?}], upToDate, notListed, untracked }`: " +
      "an entry is an update when its pin (bundle sha256 / git commit) differs and its version is " +
      "not lower than the installed one; `notListed` = the catalog no longer lists the app (or is " +
      "unreachable); `untracked` = remote installs not tied to a catalog (check those with " +
      "`app_resync`). Apply an update with `app_resync {appId}`.",
    {
      appId: z.string().optional().describe("Only check this app."),
      refresh: z.boolean().optional().describe("Bypass the 5-minute in-memory catalog cache."),
    },
    async input => {
      const apps = appRegistry
        .listApps()
        .filter(a => a.source !== undefined && a.source.kind !== "local")
        .filter(a => input.appId === undefined || a.appId === input.appId)
      if (input.appId !== undefined && apps.length === 0) {
        return errorResult(`app_updates: no app "${input.appId}" installed from git or a .agentapp.`)
      }
      const tracked = apps.filter(a => a.source !== undefined && a.source.kind !== "local" && a.source.catalogId !== undefined)
      const { remoteEntries, warnings } =
        tracked.length > 0
          ? await loadRemoteCatalogEntries(input.refresh === true, (await loadAppCatalogFile(opts.catalogPath)).sources)
          : { remoteEntries: [], warnings: [] as string[] }
      const updates: Array<Record<string, unknown>> = []
      const upToDate: string[] = []
      const notListed: string[] = []
      for (const app of tracked) {
        const src = app.source
        if (src === undefined || src.kind === "local" || src.catalogId === undefined) continue
        const ref = src.catalogId
        const hit = remoteEntries.find(r => r.catalogUrl === ref.url && r.entry.appId === ref.appId)
        if (hit === undefined) {
          notListed.push(app.appId)
          continue
        }
        if (!isCatalogUpdate(app, hit.entry)) {
          upToDate.push(app.appId)
          continue
        }
        const es = hit.entry.source
        updates.push({
          appId: app.appId,
          from:
            src.kind === "agentapp"
              ? { version: src.version, sha256: src.sha256 }
              : { ...(app.version !== undefined ? { version: app.version } : {}), sha: src.sha },
          to:
            es.kind === "agentapp"
              ? { version: es.version, sha256: es.sha256, url: es.url }
              : es.kind === "git"
                ? { ...(hit.entry.version !== undefined ? { version: hit.entry.version } : {}), sha: es.sha, url: es.url }
                : {},
          catalogUrl: hit.catalogUrl,
          ...(hit.stale ? { stale: true } : {}),
        })
      }
      const untracked = apps.filter(a => !tracked.includes(a)).map(a => a.appId)
      const result = textResult({ updates, upToDate, notListed, untracked }) as {
        content: { type: "text"; text: string }[]
      }
      if (warnings.length > 0) result.content.push({ type: "text", text: JSON.stringify({ warnings }) })
      return result
    },
  )

  const compactAppListItem = (
    app: InstalledApp & {
      dataDir: string
      dirMissing: boolean
      registryProblems?: string[]
      runs: {
        appRunId: string
        status: string
        startedAt: string
        endedAt?: string
        adapter?: string
        harness?: string
        model?: string
        sessions: number
      }[]
    },
  ) => ({
    appId: app.appId,
    name: app.name,
    version: app.version,
    description: app.description,
    dir: app.dir,
    dataDir: app.dataDir,
    ...(app.source !== undefined ? { source: app.source } : {}),
    ...(app.dirMissing ? { dirMissing: true } : {}),
    ...(app.registryProblems ? { registryProblems: app.registryProblems } : {}),
    agents: app.agents.map(a => a.id),
    workflows: app.workflows.map(w => w.id),
    requires: app.requires,
    runs: app.runs,
  })

  const appListSchema = z.object({})
  type AppListInput = z.infer<typeof appListSchema>

  registerBuiltinTool<AppListInput, (InstalledApp & { dataDir: string; dirMissing: boolean; registryProblems?: string[] })[]>(server, {
    id: "app_list",
    description: "List installed apps, each with a summary of its app_run history. " +
      "COMPACT BY DEFAULT: each entry keeps appId/name/version/description/" +
      "dir/dataDir plus slim agent/workflow id lists and the per-run " +
      "summary (appRunId/status/timing/adapter/harness/model/session " +
      "count); pass `full: true` (or `compact: false`) for the complete " +
      "installed record including ui/artifact/skill/dev details and the " +
      "full agent/workflow refs. `dirMissing: true` flags an install whose " +
      "`dir` no longer exists on disk (moved worktree, deleted checkout) — " +
      "its ui panel (if any) serves an error page until reinstalled.",
    inputSchema: appListSchema,
    handler: async () => {
      const runs = appRegistry.listRuns()
      const issues = appRegistry.listIssues()
      return appRegistry.listApps().map(app => ({
        ...app,
        dataDir: appDataDir(app),
        dirMissing: !existsSync(app.dir),
        ...(issues.some(i => i.appId === app.appId)
          ? { registryProblems: issues.filter(i => i.appId === app.appId).flatMap(i => [...i.problems]) }
          : {}),
        runs: runs
          .filter(r => r.appId === app.appId)
          .map(r => ({
            appRunId: r.appRunId,
            status: r.status,
            startedAt: r.startedAt,
            ...(r.endedAt ? { endedAt: r.endedAt } : {}),
            ...(r.adapter !== undefined ? { adapter: r.adapter } : {}),
            ...(r.harness !== undefined ? { harness: r.harness } : {}),
            ...(r.model !== undefined ? { model: r.model } : {}),
            sessions: r.sessions.length,
          })),
      }))
    },
    transformers: [
      catchErrors(),
      paginatedLegacyList({
        project: compactAppListItem,
        keyOf: a => a.appId,
        defaultBody: rows => rows,
      }),
    ],
  })

  server.tool(
    "app_run",
    "Run an installed app's agents as live sessions — one `agent_start`-equivalent " +
      "spawn per selected agent, grouped under a fresh appRunId. Poll with " +
      "`app_status`, kill with `app_stop`. " +
      'Details: tool_help {name:"app_run", topic:"orchestration"} (also "adapter support", "runner selection")',
    {
      appId: z.string(),
      agents: z
        .array(z.string())
        .optional()
        .describe("Agent ids to run concurrently. Omit to run every agent the app bundles. Ignored when `sequence` is set."),
      sequence: z
        .array(z.string())
        .optional()
        .describe("Agent ids to run ONE-AT-A-TIME in this order — each waits for the previous to finish before the next spawns."),
      wait: z
        .boolean()
        .optional()
        .describe(
          "Whether a sequential run waits for every agent to finish before returning. " +
            "Defaults to true. With sequence + false, returns after the first spawn and " +
            "continues in the background; poll with app_status.",
        ),
      prompt: z.string().optional().describe("Prompt to send to each spawned agent session."),
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory for spawned sessions. Defaults to the app's installed `dir`, and the " +
            "sessions then belong to the app's own workspace (`app-<slug>`).",
        ),
      scopeId: z
        .string()
        .optional()
        .describe("When passed, refuse to run if the app is not applied to this scope."),
      adapter: z
        .string()
        .optional()
        .describe(
          "Agent adapter slug. Omitted → EACH agent resolves its own (AGENT.md " +
            "`metadata.adapter`/`metadata.harness` > `claude-*` model → `claude-code` > " +
            "`mastra-agent`). Given → this slug is used for EVERY agent; sets `harness` " +
            "when `harness` is absent.",
        ),
      harness: z
        .string()
        .optional()
        .describe(
          "Canonical harness slug (defaults to `adapter`, or to each agent's resolved " +
            "adapter when neither is given). Recorded on the run + each session; sets " +
            "`adapter` when `adapter` is absent.",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Model id passed through to each spawned session. This wins over the " +
            "AGENT.md frontmatter's own `model`; when both are omitted, the adapter " +
            "keeps its default model.",
        ),
      access: z
        .object({ profileRef: z.string().optional() })
        .optional()
        .describe(
          "Named auth-profile pin threaded to every spawn's `agent_start`-equivalent " +
            "(see `agent_start.access`) — e.g. `{ profileRef: \"claude-subs-agentik\" }` " +
            "when the adapter's default credential profile is disabled on this host.",
        ),
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

      // The app's own workspace (`app-<slug>`), backfilled here for apps
      // installed before app-owned workspaces existed. An explicit caller
      // `cwd` keeps the spawn path's own cwd → workspace matching instead.
      const appWorkspaceSlug =
        input.cwd === undefined
          ? await ensureAppWorkspace({
              appId: app.appId,
              dir: app.dir,
              ...(opts.workspacesConfigPath !== undefined ? { configPath: opts.workspacesConfigPath } : {}),
            })
          : undefined

      if (app.agents.length === 0) {
        return errorResult(`app_run: app "${app.appId}" declares no agents; open its UI panel instead.`)
      }

      // Resolve the runner (A). `harness` is canonical: it wins the harness
      // slot and (when `adapter` absent) the adapter slot too. A bare `adapter`
      // fills both. NEITHER given → there is no run-wide runner at all: each
      // agent resolves its own inside `spawnOne` (F26, the same order
      // `resolveAgentRefsForWorkflow` applies to workflow agent refs), so the
      // A2A task route — which calls `app_run` with only `{appId, agents,
      // prompt}` — no longer forces every agent onto a blanket default; an
      // agent whose metadata and model route resolve to nothing lands in the
      // run's `errors` instead. A caller-given adapter/harness still wins for
      // EVERY agent.
      const callerAdapter = input.adapter ?? input.harness
      const callerHarness = callerAdapter === undefined ? undefined : (input.harness ?? input.adapter)!
      const model = input.model

      // Run-level `adapter`/`harness` (recorded on the run, echoed by the
      // result): a caller-given pair keeps today's semantics; resolved per
      // agent, the run reports the FIRST agent's resolved runner — `spawnOne`
      // fills this in before the run record is created, at most once.
      let runAdapter = callerAdapter
      let runHarness = callerHarness
      const reportedRunner = () => ({
        adapter: runAdapter ?? DEFAULT_AGENT_ADAPTER,
        harness: runHarness ?? runAdapter ?? DEFAULT_AGENT_ADAPTER,
      })

      // B — the AGENT.md reaches EVERY harness (AIP-42 is runner-agnostic):
      // `projectAgentToSpawn` turns it into spawn fields for the RESOLVED
      // adapter (adapters may differ per agent in one run). Only an adapter
      // whose manifest names an AGENT.md-path option (`agentManifestOption`,
      // mastra-agent) is pointed at the path; any other gets the rendered
      // instructions, skills and gateway tool scope, plus a harness warning
      // for whatever it can't honour. The resolver facts are cached by slug:
      // N agents on one adapter resolve its manifest once.
      const capsBySlug = new Map<string, Promise<AgentProjectionCaps>>()
      const capsFor = (slug: string): Promise<AgentProjectionCaps> => {
        let caps = capsBySlug.get(slug)
        if (caps === undefined) {
          caps = projectionCapsFor(resolveAgentAdapter, slug)
          capsBySlug.set(slug, caps)
        }
        return caps
      }

      const ordered = input.sequence ?? input.agents ?? app.agents.map(a => a.id)
      const unknown = ordered.filter(id => !app.agents.some(a => a.id === id))
      if (unknown.length > 0) {
        return errorResult(
          `app_run: unknown agent id(s) for app "${app.appId}": ${unknown.join(", ")}`,
        )
      }

      const sessions: { agentId: string; sessionId: string }[] = []
      const errors: { agentId: string; error: string }[] = []
      const spawnOne = async (
        agentId: string,
      ): Promise<{ agentId: string; sessionId: string } | null> => {
        const agentPath = app.agents.find(a => a.id === agentId)!.path

        // AGENT.md is read once per agent: adapter selection needs its
        // `metadata`, the spawn its model/body/tools/skills. An unreadable
        // file fails this one agent only.
        let loaded: LoadedAgentManifest
        try {
          loaded = await loadAgentPromptDefaults(agentPath, resolveModelRole)
        } catch (err) {
          errors.push({
            agentId,
            error: `could not read AGENT.md "${agentPath}": ${err instanceof Error ? err.message : String(err)}`,
          })
          return null
        }

        let adapterSlug: string
        let harnessSlug: string
        if (callerAdapter === undefined) {
          const resolved = resolveAgentSpawnAdapter(loaded.model, loaded.metadata, model)
          if (resolved === undefined) {
            // No metadata adapter/harness and no model route — fail THIS
            // agent like any other spawn failure, never a silent
            // mastra-agent fallback the author never asked for.
            errors.push({ agentId, error: noAdapterError(agentId) })
            return null
          }
          adapterSlug = resolved
          harnessSlug = resolved
        } else {
          adapterSlug = callerAdapter
          harnessSlug = callerHarness ?? callerAdapter
        }
        if (runAdapter === undefined) {
          runAdapter = adapterSlug
          runHarness = harnessSlug
        }

        const projected = projectAgentToSpawn(loaded, await capsFor(adapterSlug), model)
        const spawnModel = projected.model
        // Only the PREFIX rides the prompt (no-channel adapter); a channel
        // adapter's text goes through `appendSystemPrompt` instead, so it
        // never duplicates here.
        const spawnPrompt = prefixPrompt(projected.instructions, input.prompt)
        const result = await spawnAgentSession(
          {
            registry,
            resolveAgentAdapter,
            ...(opts.daemonMcpUrl !== undefined ? { daemonMcpUrl: opts.daemonMcpUrl } : {}),
          },
          {
            adapter: adapterSlug,
            ...(harnessSlug !== adapterSlug ? { harness: harnessSlug } : {}),
            ...(spawnModel !== undefined ? { model: spawnModel } : {}),
            cwd: input.cwd ?? app.dir,
            ...(appWorkspaceSlug !== undefined ? { workspaceSlug: appWorkspaceSlug } : {}),
            appBoundary: buildAppBoundary({
              app,
              // An operator-chosen cwd outside the app is readable, never writable.
              ...(input.cwd !== undefined ? { extraReadOnly: [input.cwd] } : {}),
              ...(opts.daemonWorkspace !== undefined ? { daemonWorkspace: opts.daemonWorkspace } : {}),
            }),
            ...(spawnPrompt ? { prompt: spawnPrompt } : {}),
            ...(projected.options ? { options: projected.options } : {}),
            ...(projected.skills ? { skills: projected.skills } : {}),
            ...(projected.tools ? { allowTools: projected.tools } : {}),
            ...(projected.systemPrompt !== undefined
              ? { appendSystemPrompt: projected.systemPrompt }
              : {}),
            ...(projected.warnings.length > 0 ? { harnessWarnings: projected.warnings } : {}),
            ...(input.access ? { access: input.access } : {}),
            appId: app.appId,
            label: `app:${app.appId}:${agentId}`,
          },
        )
        if (result.ok) {
          const output = result.output ?? []
          const meaningful = output.filter(l => !isBlankText(l))
          // D — a session that ends with nothing but blank/empty text blocks is
          // still a completed session (not an error); surface the fact so a
          // downstream consumer (or a human reading the daemon log) never
          // mistakes a blank block for missing output.
          if (meaningful.length === 0) {
            console.log(
              `app_run: session "${result.descriptor.id}" (agent "${agentId}") completed with empty output`,
            )
          }
          return { agentId, sessionId: result.descriptor.id }
        }
        errors.push({ agentId, error: result.message })
        return null
      }

      const waitForTerminal = opts.waitForSessionTerminal ?? ((sessionId: string) =>
        waitForSessionTerminal(registry, sessionId))

      if (input.sequence !== undefined) {
        // Capture BEFORE entering any closure: `input.sequence`'s definedness
        // is narrowed by this check, but a closure referencing it re-widens
        // (TS18048) — a local binding keeps the narrowed `string[]` type.
        const sequence = input.sequence
        if (input.wait === false) {
          // Match agent_start's non-waiting shape: wait for a real first
          // session descriptor, create the durable run, then release the MCP
          // call before waiting for that session to finish. Later sessions
          // are appended (and persisted) as the background sequence advances.
          const firstAgentId = sequence[0]
          const firstSpawned = firstAgentId === undefined ? null : await spawnOne(firstAgentId)
          if (firstSpawned) sessions.push(firstSpawned)

          const run = appRegistry.createRun({
            appId: app.appId,
            sessions,
            ...reportedRunner(),
            ...(model !== undefined ? { model } : {}),
          })

          const continueSequence = async (): Promise<void> => {
            if (firstSpawned) await waitForTerminal(firstSpawned.sessionId)
            for (const agentId of sequence.slice(1)) {
              // app_stop owns a stopped run; it must also prevent the
              // background worker from spawning the next agent.
              if (run.status !== "running") return
              const spawned = await spawnOne(agentId)
              if (!spawned) continue
              appRegistry.addRunSession(run.appRunId, spawned)
              await waitForTerminal(spawned.sessionId)
            }
            if (run.status === "running") {
              appRegistry.endRun(run.appRunId, {
                status: errors.length > 0 ? "failed" : "succeeded",
                ...(errors.length > 0 ? { error: errors.map(e => `${e.agentId}: ${e.error}`).join("; ") } : {}),
              })
            }
          }
          void continueSequence().catch(err => {
            console.error(
              `app_run: background sequence "${run.appRunId}" failed: ${err instanceof Error ? err.message : String(err)}`,
            )
            if (run.status === "running") {
              appRegistry.endRun(run.appRunId, { status: "failed", error: err instanceof Error ? err.message : String(err) })
            }
          })

          return textResult({
            appRunId: run.appRunId,
            status: run.status,
            sessions,
            ...(errors.length > 0 ? { errors } : {}),
          })
        }

        // B — sequential orchestration: spawn one-at-a-time, each awaited to a
        // terminal state before the next spawns, all under ONE appRunId.
        for (const agentId of sequence) {
          const spawned = await spawnOne(agentId)
          if (!spawned) continue
          sessions.push(spawned)
          await waitForTerminal(spawned.sessionId)
        }
        const run = appRegistry.createRun({
          appId: app.appId,
          sessions,
          ...reportedRunner(),
          ...(model !== undefined ? { model } : {}),
        })
        appRegistry.endRun(run.appRunId, {
          status: errors.length > 0 ? "failed" : "succeeded",
          ...(errors.length > 0 ? { error: errors.map(e => `${e.agentId}: ${e.error}`).join("; ") } : {}),
        })
        return textResult({
          appRunId: run.appRunId,
          status: run.status,
          ...(run.endedAt ? { endedAt: run.endedAt } : {}),
          sessions,
          ...(errors.length > 0 ? { errors } : {}),
        })
      }

      for (const agentId of ordered) {
        const spawned = await spawnOne(agentId)
        if (spawned) sessions.push(spawned)
      }

      const run = appRegistry.createRun({
        appId: app.appId,
        sessions,
        ...reportedRunner(),
        ...(model !== undefined ? { model } : {}),
      })
      return textResult({
        appRunId: run.appRunId,
        ...reportedRunner(),
        ...(model !== undefined ? { model } : {}),
        sessions,
        ...(errors.length > 0 ? { errors } : {}),
      })
    },
  )

  server.tool(
    "app_status",
    "Status of an app_run: its sessions' live descriptors, plus any workflow runs " +
      "belonging to the app (any run of one of its bundled WORKFLOW.md files, " +
      "however it was started). COMPACT BY DEFAULT (AIP-58 §9): sessions carry a " +
      "slim {agentId, sessionId, status} instead of the full session descriptor, " +
      "and each workflowRuns entry omits step outputs / gate-report bodies — pass " +
      "`full: true` for everything. `dirMissing: true` is present when the app's " +
      "installed `dir` no longer exists on disk.",
    { appRunId: z.string(), full: z.boolean().optional().describe("Include full session descriptors and workflow-run step outputs. Defaults to false (compact).") },
    async input => {
      const run = appRegistry.getRun(input.appRunId)
      if (!run) return errorResult(`app_status: no app run "${input.appRunId}".`)
      const app = appRegistry.getApp(run.appId)
      const descriptors = run.sessions.map(s => ({ ...s, descriptor: registry.get(s.sessionId) }))
      const sessions = input.full === true
        ? descriptors
        : descriptors.map(s => ({ agentId: s.agentId, sessionId: s.sessionId, status: s.descriptor?.status }))
      const allWorkflowRuns =
        workflowRunner && app
          ? workflowRunner.list().filter(r => app.workflows.some(w => w.id === r.workflowId))
          : []
      // AIP-58 §2 terminal-state reconciliation (F8/F14): a concurrent run's
      // STORED status is only ever flipped by `app_stop` or the liveness
      // sweep (see `sweepAppRuns`), so a run whose sessions (and any
      // workflow runs it owns) have all reached a terminal fate would
      // otherwise report "running" forever. Reconcile lazily here (never
      // persisted — the sweep is the sole writer) so a poll between sweep
      // ticks still reads truthfully.
      const ownWorkflowRunStatuses = allWorkflowRuns
        .filter(r => r.appRunId === run.appRunId)
        .map(r => r.status)
      const reconciled =
        run.status !== "running"
          ? { status: run.status }
          : reconcileAppRunStatus({
              sessions: descriptors.map(s => ({ status: s.descriptor?.status })),
              workflowRunStatuses: ownWorkflowRunStatuses,
            })
      const reconciledStatus = reconciled.status
      const workflowRuns =
        input.full === true && workflowRunner
          ? allWorkflowRuns.map(r => workflowRunner.status(r.runId) ?? r)
          : allWorkflowRuns.map(compactWorkflowRunStatus)
      // WP-S: parked human approvals across the app's workflow runs — what a
      // UI renders as the permissions inbox for this app.
      const awaitingApprovals = allWorkflowRuns
        .filter(r => r.awaitingApproval !== undefined)
        .map(r => {
          const aa = r.awaitingApproval!
          return {
            runId: r.runId,
            approvalId: aa.approvalId,
            stepId: aa.stepId,
            prompt: aa.prompt,
            since: aa.since,
            ...(r.appRunId !== undefined ? { appRunId: r.appRunId } : {}),
          }
        })
      // Read-only state-ledger projection (app-state.ts): when the app has
      // a ledger on disk, `app_status` carries the folded stage snapshot so
      // a UI can render the stage board without a separate app_state_get.
      let state: { snapshot: Awaited<ReturnType<typeof appStateSnapshot>> } | undefined
      if (app && (await appStateLedgerExists(app))) {
        state = { snapshot: await appStateSnapshot(app) }
      }
      return textResult({
        appRunId: run.appRunId,
        appId: run.appId,
        ...(app?.source !== undefined ? { source: app.source } : {}),
        status: reconciledStatus,
        startedAt: run.startedAt,
        ...(reconciledStatus !== "running" && run.endedAt
          ? { endedAt: run.endedAt }
          : reconciledStatus !== "running"
            ? { endedAt: new Date().toISOString() }
            : {}),
        ...("errorCode" in reconciled && reconciled.errorCode !== undefined ? { errorCode: reconciled.errorCode } : run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
        ...(run.error !== undefined ? { error: run.error } : {}),
        ...(run.adapter !== undefined ? { adapter: run.adapter } : {}),
        ...(run.harness !== undefined ? { harness: run.harness } : {}),
        ...(run.model !== undefined ? { model: run.model } : {}),
        sessions,
        workflowRuns,
        ...(awaitingApprovals.length > 0 ? { awaitingApprovals } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(app && !existsSync(app.dir) ? { dirMissing: true } : {}),
      })
    },
  )

  server.tool(
    "app_stop",
    "Kill every session in an app_run (existing kill path) and mark the run cancelled.",
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
      const ended = appRegistry.endRun(input.appRunId, { status: "cancelled" })
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
      dataDir: z.string().optional().describe("Data root to install with (see app_install). Only used when installing."),
    },
    async input => {
      const scopeId = input.scopeId ?? "root"
      let installed = appRegistry.getApp(input.appId)

      if (!installed && input.dir) {
        const installResult = await performInstall(input.dir, appRegistry, listRegisteredToolIds, resolveAgentAdapter, {
          ...(input.dataDir !== undefined ? { dataDir: input.dataDir } : {}),
          ...(opts.workspacesConfigPath !== undefined ? { workspacesConfigPath: opts.workspacesConfigPath } : {}),
          ensureServices,
        })
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

      for (const dep of installed.requiresApps ?? []) {
        if (dep.version === undefined) continue
        const provider = appRegistry.getApp(dep.id)
        if (!provider) continue
        const problem = checkVersion(provider.version, dep.version)
        if (problem !== undefined) {
          return errorResult(
            `app_apply: app "${input.appId}" requires "${dep.id}" ${dep.version}, but "${dep.id}" ${problem}.`,
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
        ...(installed.agents.length === 0
          ? { note: "app declares no agents — nothing to activate in this scope; open its UI panel directly." }
          : {}),
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

  const compactAppliedMount = (
    m: {
      scopeId: string
      appId: string
      appliedAt: string
      agents?: readonly InstalledAppRef[]
      workflows?: readonly InstalledAppRef[]
    },
  ) => ({
    scopeId: m.scopeId,
    appId: m.appId,
    appliedAt: m.appliedAt,
    ...(m.agents ? { agents: m.agents.map(a => a.id) } : {}),
    ...(m.workflows ? { workflows: m.workflows.map(w => w.id) } : {}),
  })

  const appListAppliedSchema = z.object({
    scopeId: z.string().optional().describe("Filter by scope. Omit to list all scopes."),
  })
  type AppListAppliedInput = z.infer<typeof appListAppliedSchema>

  type AppliedMountItem = {
    scopeId: string
    appId: string
    appliedAt: string
    agents?: readonly InstalledAppRef[]
    workflows?: readonly InstalledAppRef[]
    unvalidatedAgentTools?: readonly string[]
  }

  registerBuiltinTool<AppListAppliedInput, AppliedMountItem[]>(server, {
    id: "app_list_applied",
    description: "List applied mounts, optionally filtered by scope. Each mount is " +
      "joined with its installed app summary. COMPACT BY DEFAULT: each " +
      "entry keeps scopeId/appId/appliedAt plus slim agent/workflow id " +
      "lists; pass `full: true` (or `compact: false`) for the complete " +
      "join including `unvalidatedAgentTools` as full refs.",
    inputSchema: appListAppliedSchema,
    handler: async (input) => {
      const mounts = appRegistry.listApplied(input.scopeId)
      return mounts.map(mount => {
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
    },
    transformers: [
      catchErrors(),
      paginatedLegacyList({
        project: compactAppliedMount,
        keyOf: m => `${m.scopeId}/${m.appId}`,
        defaultBody: rows => rows,
      }),
    ],
  })

  const DEFAULT_APP_LINK_TTL_MS = 60 * 60_000
  const DEFAULT_APP_LINK_SESSION_TTL_MS = 30 * 60_000

  server.tool(
    "app_link_mint",
    "PRIVILEGED — mint a Telegram-identity-gated AIP-53 link token for an installed app's UI (e.g. the " +
      "link a Telegram bot sends for `@agentik/session-chat`). The token ALONE never grants access: " +
      "whoever opens it must first pass `POST /apps/:appId/link-auth` with their Telegram Mini App " +
      "`initData`, which the daemon verifies against the stored bot token (telegram_bot_token_set) and " +
      "the exact telegramUserId claimed here — only a matching account exchanges it for a short-lived " +
      "session token that can actually call tools (scoped by the app's `ui.toolScope`) or read that one " +
      "session. Never put \"app_link_mint\" in an app's `ui.tools` — it is refused there and unreachable " +
      "from any UI's own tool-call surface regardless.",
    {
      appId: z.string().describe("Installed app id — must declare a non-empty `ui.toolScope`."),
      sessionId: z.string().min(1).describe("The session this link is scoped to."),
      telegramUserId: z.string().min(1).describe("The Telegram numeric user id (as a string) allowed to open this link."),
      ttlMs: z.number().int().positive().optional().describe("How long the link stays openable before Telegram auth. Default 1 hour."),
      sessionTtlMs: z.number().int().positive().optional().describe("How long the resulting session token lasts once authorized. Default 30 minutes."),
      botAlias: z.string().optional().describe('Telegram bot alias to verify against at link-auth time; default "default".'),
    },
    async ({ appId, sessionId, telegramUserId, ttlMs, sessionTtlMs, botAlias }) => {
      const installed = appRegistry.getApp(appId)
      if (!installed || !installed.ui) {
        return errorResult(`app_link_mint: app "${appId}" is not installed or has no UI.`)
      }
      if (!installed.ui.toolScope || Object.keys(installed.ui.toolScope).length === 0) {
        return errorResult(
          `app_link_mint: app "${appId}" declares no \`ui.toolScope\` — a link token would have no scoped tools to call.`,
        )
      }
      const { token, exp } = mintAppLinkToken({
        appId,
        claims: {
          sessionId,
          telegramUserId,
          sessionTtlMs: String(sessionTtlMs ?? DEFAULT_APP_LINK_SESSION_TTL_MS),
          ...(botAlias ? { botAlias } : {}),
        },
        ttlMs: ttlMs ?? DEFAULT_APP_LINK_TTL_MS,
        pendingTelegramAuth: true,
      })
      return textResult({ linkToken: token, exp, appId, sessionId, telegramUserId })
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
    "app_call",
    "Call a workflow an installed provider app exposes, on behalf of an installed consumer app — " +
      "the app→app call mechanism. The caller must declare the provider in `requires.apps`, and the " +
      "dependency entry's `workflows` allowlist must name the workflow; the provider must list it in " +
      "`exposes.workflows`, and its installed version must satisfy the dependency's `version` range " +
      "when both are set. The workflow then runs through the same runner path as `workflow_run_file` " +
      "and the call awaits its result under a bounded timeout. " +
      "TRUST MODEL: the daemon is local-trust — `callerAppId` is a declaration check, NOT a security " +
      "boundary; any local process can name any installed caller, and apps are not isolated from " +
      "each other. Errors carry a distinct errorCode (caller-not-installed / not-declared / " +
      "workflow-not-allowed / provider-not-installed / workflow-not-exposed / version-mismatch / " +
      "workflow-failed / timeout).",
    {
      callerAppId: z.string().describe("The installed consumer app making the call."),
      appId: z.string().describe("The provider app id — must be in the caller's requires.apps."),
      workflow: z
        .string()
        .describe("Workflow id — must be in the provider's exposes.workflows AND the caller's dependency allowlist."),
      input: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Workflow input, bound to `$input` in the compiled workflow."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Bounded wait for the workflow to finish, in milliseconds. Default 60000, capped at 300000.",
        ),
    },
    async input => {
      const result = await performAppCall(appRegistry, input, {
        ...(workflowRunner ? { workflowRunner } : {}),
      })
      if (!result.ok) return errorResult(result.error)
      return textResult({ ok: true, output: result.output, runId: result.runId, durationMs: result.durationMs })
    },
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
      // Kill every service owner (session + recorded pid) and drop its
      // ownership record — otherwise a reinstall spawns a second owner for a
      // service still running from the old install.
      const killedServices = await removeAppServiceOwners({
        store: serviceStore,
        appId: removed.appId,
        killOwner: opts.killServiceOwner ?? killServiceOwner,
      })
      await unregisterAppWorkspace(removed.appId, opts.workspacesConfigPath)
      return textResult({ appId: removed.appId, ...(killedServices.length > 0 ? { services: killedServices } : {}) })
    },
  )

  server.tool(
    "app_catalog",
    "List browsable apps from the catalog file (default `~/.agentproto/app-catalog.json`, " +
      "tolerates a missing file), merged with installed-app status — every entry reports " +
      "`installed`, `hasUi`, `hasArtifact`, and `hasSkill`. Remote catalogs (`app-catalog/v1`) " +
      "are appended after local entries, deduped by `appId` (first wins): the default public " +
      "catalog first (config `catalog.defaultSource`, `false` turns it off), then config " +
      "`catalog.sources` (else `sources` in the catalog file) — extra sources ADD to the default " +
      "one. Remote entries carry `source` (for `app_install`), `origin` (default|config|file|" +
      "embedded), `catalogUrl`, the optional v1 fields (version, tier, icon, publisher, publisherUrl, license, " +
      "requires, minAgentprotoVersion, featured), and `stale: true` when served from the disk " +
      "cache (or, for the default catalog when it was never reachable, from the embedded " +
      "first-party list). A failing source is reported in a trailing `{ warnings: [...] }` " +
      "content block, never as an error. Installed apps absent from the catalog are included " +
      "too, as are the always-on builtin panels (category `builtin`).",
    {
      scopeId: z
        .string()
        .optional()
        .describe("Reserved for future scope-aware filtering. Currently unused."),
      refresh: z
        .boolean()
        .optional()
        .describe("Bypass the 5-minute remote-source cache and refetch every source."),
    },
    async input => {
      const catalog = await loadAppCatalogFile(opts.catalogPath)
      const installedApps = appRegistry.listApps()
      const installedById = new Map(installedApps.map(a => [a.appId, a]))
      const seen = new Set<string>()

      const entries: Array<Record<string, unknown>> = catalog.apps.map(entry => {
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

      const { remoteEntries, warnings: remoteWarnings } = await loadRemoteCatalogEntries(
        input.refresh === true,
        catalog.sources,
      )

      for (const { entry, origin, catalogUrl, stale } of remoteEntries) {
        if (seen.has(entry.appId)) continue
        seen.add(entry.appId)
        const installed = installedById.get(entry.appId)
        const name = entry.name ?? installed?.name
        const description = entry.description ?? installed?.description
        const installedCatalog =
          installed?.source !== undefined && installed.source.kind !== "local" ? installed.source.catalogId : undefined
        const updateAvailable =
          installed !== undefined &&
          installedCatalog !== undefined &&
          installedCatalog.url === catalogUrl &&
          isCatalogUpdate(installed, entry)
        entries.push({
          appId: entry.appId,
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
          ...(entry.category ? { category: entry.category } : {}),
          source: entry.source,
          ...(entry.placement ? { placement: entry.placement } : {}),
          ...(entry.version ? { version: entry.version } : {}),
          ...(entry.tier ? { tier: entry.tier } : {}),
          ...(entry.icon ? { icon: entry.icon } : {}),
          ...(entry.publisher ? { publisher: entry.publisher } : {}),
          ...(entry.publisherUrl ? { publisherUrl: entry.publisherUrl } : {}),
          ...(entry.license ? { license: entry.license } : {}),
          ...(entry.requires ? { requires: entry.requires } : {}),
          ...(entry.minAgentprotoVersion ? { minAgentprotoVersion: entry.minAgentprotoVersion } : {}),
          ...(entry.featured ? { featured: true } : {}),
          origin,
          catalogUrl,
          ...(stale ? { stale: true } : {}),
          installed: installed !== undefined,
          ...(updateAvailable ? { updateAvailable: true, installedVersion: installed?.version } : {}),
          hasUi: installed?.ui !== undefined,
          hasArtifact: installed?.artifact !== undefined,
          hasSkill: installed?.skill !== undefined,
        })
      }

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

      // Builtin panels (sessions-panel, agents-overview, bureau-sessions,
      // session-story, live-session) — always present, no app_install
      // step, never persisted to ~/.agentproto/apps.json.
      entries.push(...builtinPanelCatalogEntries().map(e => ({ ...e })))

      // Entries stay the first content block (a bare JSON array) so existing
      // clients keep parsing; warnings ride in a second block only when present.
      const result = textResult(entries) as { content: { type: "text"; text: string }[] }
      if (remoteWarnings.length > 0) {
        result.content.push({ type: "text", text: JSON.stringify({ warnings: remoteWarnings }) })
      }
      return result
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
