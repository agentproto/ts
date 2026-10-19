/**
 * `defineApp({ agents, workflows, attach })` — bundle one or more AIP-42
 * agents, the AIP-15 workflows they run, and any other AIP artifacts into
 * one cross-linked, frozen handle.
 *
 * The only new invariant app-kit adds is *attachment*: the agents and the
 * bundled workflows must reference each other. Everything else (field
 * validation) already ran when the caller built the handles with
 * `defineAgent` / `defineWorkflow`, so `defineApp` validates the coupling,
 * not the fields.
 *
 *   - agent ids are unique within the app.
 *   - every `agent.workflows[]` ref MUST resolve to a bundled workflow id.
 *   - every bundled workflow MUST be referenced by at least one agent.
 *
 * A dangling ref (an agent points at a workflow the app didn't bundle) or
 * an orphan (a bundled workflow no agent lists) throws — that is what "an
 * agent attached to its workflows" means, made checkable.
 */

import { isAbsolute } from "node:path"
import { defineWorkspace } from "@agentproto/workspace"
import type { AgentHandle, AnyRef } from "@agentproto/agent"
import type { BuildMastraAgentResult } from "@agentproto/mastra"
import type { WorkflowHandle } from "@agentproto/workflow"
import type { WorkspaceHandle } from "@agentproto/workspace"
import type {
  AgentEntry,
  AppDefinition,
  AppHandle,
  AppRequirement,
  AppService,
  AppSetupPersist,
  AppSetupStep,
  DoctypeHandle,
  OpenAIAppUiExtension,
  OpenAIEntrypoint,
  OpenAIIcon,
  ToMastraAgentOptions,
  WorkspaceInput,
} from "./types.js"
import { refKey } from "./refs.js"
import { emitApp } from "./emit.js"
import { normalizeManifestFields } from "./manifest-fields.js"

export class AppDefinitionError extends Error {
  constructor(message: string) {
    super(`defineApp (app-kit): ${message}`)
    this.name = "AppDefinitionError"
  }
}

export function defineApp(def: AppDefinition): AppHandle {
  if (def.id !== undefined && def.id.trim() === "") {
    throw new AppDefinitionError("`id` must be non-empty when present.")
  }
  if (def.ui !== undefined && (typeof def.ui.html !== "string" || def.ui.html.trim() === "")) {
    throw new AppDefinitionError("`ui.html` must be a non-empty string when `ui` is present.")
  }
  if ((def.agents === undefined || def.agents.length === 0) && def.ui === undefined) {
    throw new AppDefinitionError(
      "an app needs at least one agent, or a `ui` block for a UI-only app — got neither.",
    )
  }
  if (def.dev !== undefined && (!Array.isArray(def.dev.launch) || def.dev.launch.length === 0)) {
    throw new AppDefinitionError("`dev.launch` must be a non-empty array when `dev` is present.")
  }
  if (def.data !== undefined && def.data.dir !== undefined && (typeof def.data.dir !== "string" || def.data.dir.trim() === "")) {
    throw new AppDefinitionError("`data.dir` must be a non-empty string when present.")
  }
if (def.artifact !== undefined && (typeof def.artifact.path !== "string" || def.artifact.path.trim() === "")) {
    throw new AppDefinitionError("`artifact.path` must be a non-empty string when `artifact` is present.")
  }
  // AIP-53 rule 7: `artifact.path` / `skill.path` MUST be absolute —
  // `emit` copies from them at write time and a relative path has no
  // defined base to resolve against.
  if (def.artifact !== undefined && !isAbsolute(def.artifact.path)) {
    throw new AppDefinitionError(
      `\`artifact.path\` must be an absolute filesystem path, got '${def.artifact.path}' — a relative path has no defined base to resolve against (AIP-53 rule 7).`,
    )
  }
  if (def.skill !== undefined && (typeof def.skill.path !== "string" || def.skill.path.trim() === "")) {
    throw new AppDefinitionError("`skill.path` must be a non-empty string when `skill` is present.")
  }
  if (def.skill !== undefined && !isAbsolute(def.skill.path)) {
    throw new AppDefinitionError(
      `\`skill.path\` must be an absolute filesystem path, got '${def.skill.path}' — a relative path has no defined base to resolve against (AIP-53 rule 7).`,
    )
  }
  if (def.category !== undefined && def.category.trim() === "") {
    throw new AppDefinitionError("`category` must be a non-empty string when present.")
  }

  const agents = (def.agents ?? []).map(normalizeEntry)
  const workflows = def.workflows ?? []
  const tools = def.tools ?? []
  const drivers = def.drivers ?? []
  const attachments = def.attach ?? []
  const workspace = def.workspace ? toWorkspaceHandle(def.workspace) : undefined
  const id = def.id
  const name = def.name
  const version = def.version ?? (id ? "0.1.0" : undefined)
  const description = def.description
  const fields = normalizeManifestFields(
    {
      placement: def.placement,
      requires: def.requires,
      exposes: def.exposes,
      accepts: def.accepts,
      services: def.services,
      setup: def.setup,
    },
    { agents: agents.map(e => e.agent.id), workflows: workflows.map(w => w.id) },
    msg => new AppDefinitionError(msg),
  )
  const requires = fields.requires ? Object.freeze([...fields.requires]) : undefined
  const requirements = Object.freeze({
    ...fields.requirements,
    secrets: Object.freeze([...fields.requirements.secrets]),
    apps: Object.freeze([...fields.requirements.apps]),
  })
  const appRequirements = Object.freeze(
    fields.appRequirements.map(e => Object.freeze({ ...e, ...(e.workflows !== undefined ? { workflows: Object.freeze([...e.workflows]) } : {}) })),
  )
  const placement = fields.placement
  const exposes = Object.freeze({
    agents: Object.freeze([...fields.exposes.agents]),
    workflows: Object.freeze([...fields.exposes.workflows]),
  })
  const accepts = Object.freeze({ ...fields.accepts })
  const uiExtensions =
    def.ui === undefined || def.ui.extensions === undefined
      ? undefined
      : (Object.freeze({
          openai: freezeDeep(
            normalizeOpenAIUiExtension(
              validateOpenAIExtensionsNamespace(def.ui.extensions),
              def.ui.tools,
              msg => new AppDefinitionError(msg),
            ),
          ),
        }) as { readonly openai?: OpenAIAppUiExtension })
  if (def.ui?.renders !== undefined) {
    const allowed = new Set(def.ui.tools ?? [])
    const seen = new Set<string>()
    for (const id of def.ui.renders) {
      if (!allowed.has(id)) {
        throw new AppDefinitionError(
          `\`ui.renders\` entry '${id}' is not in \`ui.tools\` — a rendered tool must also be callable by the UI.`,
        )
      }
      if (seen.has(id)) {
        throw new AppDefinitionError(`\`ui.renders\` lists '${id}' twice.`)
      }
      seen.add(id)
    }
  }
  // `app_link_mint` is a privileged daemon verb (mints a scoped link token —
  // see `@agentproto/runtime`'s app-link-token.ts) that must NEVER be
  // reachable through an app's own UI-tool-call surface: a UI that could
  // mint its own tokens could mint one scoped to any claim it likes,
  // defeating the whole point of link-token scoping. Checked on the raw
  // `tools` list (not just via `dispatchAllowlistedAppTool`'s runtime
  // defense) so a misdeclared APP.md fails loudly at author time.
  if (def.ui?.tools?.includes("app_link_mint")) {
    throw new AppDefinitionError(
      "`ui.tools` must not include \"app_link_mint\" — minting a link token is a privileged daemon action, never reachable from a UI's own tool-call surface.",
    )
  }
  if (def.ui?.toolScope !== undefined) {
    const allowedTools = new Set(def.ui.tools ?? [])
    for (const [toolId, argMap] of Object.entries(def.ui.toolScope)) {
      if (!allowedTools.has(toolId)) {
        throw new AppDefinitionError(
          `\`ui.toolScope\` entry '${toolId}' is not in \`ui.tools\` — a scoped tool must also be in the UI's own allowlist.`,
        )
      }
      if (typeof argMap !== "object" || argMap === null || Array.isArray(argMap)) {
        throw new AppDefinitionError(`\`ui.toolScope.${toolId}\` must be an object of argName -> "$link.<claim>".`)
      }
      // An empty entry (`{}`) would make `toolId` callable with NO argument
      // constraint at all under a scoped link token — defeating the whole
      // point of scoping it rather than just leaving it out of `toolScope`.
      if (Object.keys(argMap).length === 0) {
        throw new AppDefinitionError(
          `\`ui.toolScope.${toolId}\` is empty — a scoped tool needs at least one argName -> "$link.<claim>" constraint, or it shouldn't be in \`toolScope\` at all.`,
        )
      }
      for (const [argName, claimRef] of Object.entries(argMap)) {
        if (typeof claimRef !== "string" || !/^\$link\.[A-Za-z0-9_]+$/.test(claimRef)) {
          throw new AppDefinitionError(
            `\`ui.toolScope.${toolId}.${argName}\` must look like "$link.<claim>" (e.g. "$link.sessionId"), got ${JSON.stringify(claimRef)}.`,
          )
        }
      }
    }
  }
  const ui = def.ui
    ? Object.freeze({
        ...def.ui,
        ...(uiExtensions !== undefined ? { extensions: uiExtensions } : {}),
      })
    : undefined
  const artifact = def.artifact ? Object.freeze({ ...def.artifact }) : undefined
  const skill = def.skill ? Object.freeze({ ...def.skill }) : undefined
  const artifacts = def.artifacts ? Object.freeze(def.artifacts.map(a => Object.freeze({ ...a }))) : undefined
  const dev = def.dev
    ? Object.freeze({ launch: Object.freeze(def.dev.launch.map(l => Object.freeze({ ...l }))) })
    : undefined
  // NOT A LAUNCHER. `services[]` is the production hosting surface — one
  // supervised service process per entry — and `defineApp` only validates +
  // carries it. This never spawns anything: `entry` is a plain string the
  // LATER install-time service-owner (performInstall, a separate work item)
  // runs, one keep-alive session per entry. `dev.launch` above is likewise
  // validation-only and is NEVER executed by app-kit (define-app.ts:62-64 /
  // no execution path). Conformance is asserted in __tests__: a `services`
  // entry whose `entry` would be destructive if run MUST NOT cause
  // defineApp/emit/load to execute it.
  const services: readonly AppService[] | undefined = fields.services
    ? Object.freeze(fields.services.map(s => Object.freeze({ ...s })))
    : undefined
  // AIP-53 `setup[]` — the post-install configuration pipeline. Rule 10
  // runs PURELY here (no I/O; app-kit never executes a step — see
  // manifest-fields.ts's setupList for the shape half), then the array is
  // deep-frozen onto the handle and carried verbatim by emit/load.
  if (fields.setup !== undefined) {
    validateSetupRule10(fields.setup)
  }
  const setup: readonly AppSetupStep[] | undefined = fields.setup
    ? (Object.freeze(fields.setup.map(s => freezeDeep(s))) as readonly AppSetupStep[])
    : undefined
  const externalReadRoots = def.externalReadRoots ? Object.freeze([...def.externalReadRoots]) : undefined
  const data = def.data ? Object.freeze({ ...def.data }) : undefined
  const boundaries = def.boundaries ? Object.freeze({ ...def.boundaries }) : undefined
  const category = def.category

  validateAttachment(agents, workflows)
  validateUniqueIds(tools, "tool")
  validateUniqueIds(drivers, "driver")

  const frozenAgents = Object.freeze(agents.map((e) => Object.freeze({ ...e })))
  const frozenWorkflows = Object.freeze([...workflows])
  const frozenTools = Object.freeze([...tools])
  const frozenDrivers = Object.freeze([...drivers])
  const frozenAttachments = Object.freeze([...attachments])

  const handle: AppHandle = {
    agents: frozenAgents,
    workflows: frozenWorkflows,
    tools: frozenTools,
    drivers: frozenDrivers,
    attachments: frozenAttachments,
    ...(workspace ? { workspace } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(requires !== undefined ? { requires } : {}),
    requirements,
    appRequirements,
    placement,
    exposes,
    accepts,
    ...(ui !== undefined ? { ui } : {}),
    ...(artifact !== undefined ? { artifact } : {}),
    ...(skill !== undefined ? { skill } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(dev !== undefined ? { dev } : {}),
    ...(services !== undefined ? { services } : {}),
    ...(setup !== undefined ? { setup } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(externalReadRoots !== undefined ? { externalReadRoots } : {}),
    ...(boundaries !== undefined ? { boundaries } : {}),
    ...(category !== undefined ? { category } : {}),

    async toMastraAgents(opts: ToMastraAgentOptions, only?: readonly string[]) {
      const targets = only ? selectAgents(frozenAgents, only) : frozenAgents
      const out: Record<string, BuildMastraAgentResult> = {}
      for (const entry of targets) {
        out[entry.agent.id] = await buildOne(entry, opts)
      }
      return out
    },

    pick(ids: readonly string[]) {
      return selectAgents(frozenAgents, ids)
    },

    async toMastraAgent(opts: ToMastraAgentOptions) {
      if (frozenAgents.length !== 1) {
        throw new AppDefinitionError(
          `toMastraAgent requires exactly one agent (app has ${frozenAgents.length}); use toMastraAgents.`,
        )
      }
      return buildOne(frozenAgents[0]!, opts)
    },

    emit(dir: string) {
      return emitApp(
        {
          agents: frozenAgents,
          workflows: frozenWorkflows,
          ...(workspace ? { workspace } : {}),
          ...(id !== undefined ? { id } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(version !== undefined ? { version } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(requires !== undefined ? { requires } : {}),
          requirements,
          appRequirements,
          placement,
          exposes,
          accepts,
          ...(ui !== undefined ? { ui } : {}),
          ...(artifact !== undefined ? { artifact } : {}),
          ...(skill !== undefined ? { skill } : {}),
          ...(artifacts !== undefined ? { artifacts } : {}),
          ...(dev !== undefined ? { dev } : {}),
          ...(services !== undefined ? { services } : {}),
          ...(setup !== undefined ? { setup } : {}),
          ...(data !== undefined ? { data } : {}),
          ...(externalReadRoots !== undefined ? { externalReadRoots } : {}),
          ...(boundaries !== undefined ? { boundaries } : {}),
          ...(category !== undefined ? { category } : {}),
        },
        dir,
      )
    },
  }

  return Object.freeze(handle)
}

/**
 * Normalize the `workspace` input to an AIP-34 `WorkspaceHandle`. A built
 * handle (already run through `defineWorkspace`) carries `schema:
 * "workspace/v2"` and passes straight through; a `WorkspaceShorthand` is
 * completed with a local-fs storage default, a `0.1.0` version, and a
 * `type` default of `"app"` (see `WorkspaceShorthand.type`'s doc comment),
 * then validated by `defineWorkspace` — so a malformed shorthand fails
 * with the same AIP-34 diagnostic as a malformed WORKSPACE.md.
 */
function toWorkspaceHandle(input: WorkspaceInput): WorkspaceHandle {
  if ("schema" in input) return input
  return defineWorkspace({
    schema: "workspace/v2",
    version: input.version ?? "0.1.0",
    id: input.id,
    name: input.name,
    type: input.type ?? "app",
    owner: input.owner,
    storage: input.storage ?? { inline: { provider: "local-fs", config: {} } },
    ...(input.description ? { description: input.description } : {}),
  })
}

/**
 * Resolve `ids` to their app entries, preserving the caller's order. Throws
 * `AppDefinitionError` on any id the app doesn't bundle — a hand-picked list
 * that names a missing agent is a bug, not a silent no-op.
 */
function selectAgents(
  agents: readonly AgentEntry[],
  ids: readonly string[],
): readonly AgentEntry[] {
  const byId = new Map(agents.map((e) => [e.agent.id, e]))
  return ids.map((id) => {
    const entry = byId.get(id)
    if (!entry) {
      throw new AppDefinitionError(
        `agent '${id}' is not in this app. Bundled: [${[...byId.keys()].join(", ")}].`,
      )
    }
    return entry
  })
}

async function buildOne(entry: AgentEntry, opts: ToMastraAgentOptions): Promise<BuildMastraAgentResult> {
  // Dynamic import, not a static top-level one: `@agentproto/mastra` pulls in
  // `@mastra/core` (a documented peer dependency — see index.ts), which a
  // bundler would otherwise inline into ANY host that merely calls
  // `defineApp()` without ever calling `toMastraAgent(s)` (e.g. a UI-only app
  // consumer). Loading it lazily, only from the one place it's actually used,
  // keeps `defineApp()`/the rest of this module free of that cost.
  const { buildMastraAgent } = await import("@agentproto/mastra")
  // `entry.body` (the AGENT.md body) wins as instructions; an explicit
  // `opts.body` still overrides, matching buildMastraAgent's contract.
  return buildMastraAgent(entry.agent, { body: entry.body, ...opts })
}

function normalizeEntry(input: AgentEntry | AgentHandle): AgentEntry {
  // An AgentEntry has an `.agent`; a bare AgentHandle has `.id`/`.schema`.
  if ("agent" in input) return input
  return { agent: input }
}

/**
 * The attachment invariant across all agents: bundled workflow ids and
 * the union of every agent's `workflows[]` refs must be the same set.
 * External/registry workflow refs are out of scope for an app bundle —
 * if an agent lists it, the app must ship it.
 */
function validateAttachment(
  agents: readonly AgentEntry[],
  workflows: readonly WorkflowHandle[],
): void {
  const seenAgentIds = new Set<string>()
  for (const { agent } of agents) {
    if (seenAgentIds.has(agent.id)) {
      throw new AppDefinitionError(`duplicate agent id '${agent.id}' in the bundle.`)
    }
    seenAgentIds.add(agent.id)
  }

  const bundledIds = new Set<string>()
  for (const wf of workflows) {
    if (bundledIds.has(wf.id)) {
      throw new AppDefinitionError(`duplicate workflow id '${wf.id}' in the bundle.`)
    }
    bundledIds.add(wf.id)
  }

  const referenced = new Set<string>()
  for (const { agent } of agents) {
    for (const ref of workflowRefs(agent)) {
      const key = refKey(ref)
      referenced.add(key)
      if (!bundledIds.has(key)) {
        throw new AppDefinitionError(
          `agent '${agent.id}' references workflow '${key}' but the app does not bundle it. ` +
            `Bundled: [${[...bundledIds].join(", ") || "none"}].`,
        )
      }
    }
  }

  for (const id of bundledIds) {
    if (!referenced.has(id)) {
      throw new AppDefinitionError(
        `workflow '${id}' is bundled but no agent lists it in workflows[]. ` +
          `Add { ref: "${id}" } to an agent, or drop the workflow.`,
      )
    }
  }
}

function workflowRefs(agent: AgentHandle): readonly AnyRef[] {
  return agent.workflows ?? []
}

/** Duplicate-id guard for `tools`/`drivers` — mirrors the agent/workflow id
 *  uniqueness `validateAttachment` already enforces. */
function validateUniqueIds(items: readonly { id: string }[], kind: string): void {
  const seen = new Set()
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new AppDefinitionError(`duplicate ${kind} id '${item.id}' in the bundle.`)
    }
    seen.add(item.id)
  }
}

/** The four `persist` slots of `$defs.persist` — exactly one may be set. */
const SETUP_PERSIST_SLOTS = ["env", "secret_slug", "cmd", "answer"] as const

/** A step's `persist` block, when its kind declares one (vendor `x-*`
 *  steps are open-shaped and not checked here). */
function setupPersistOf(step: AppSetupStep): AppSetupPersist | undefined {
  switch (step.kind) {
    case "cmd":
    case "prompt":
    case "choice":
    case "pairing":
    case "external":
      return step.persist
    default:
      return undefined
  }
}

/**
 * AIP-53 conformance rule 10 — the `setup[]` pipeline invariants, checked
 * PURELY on the shape-validated array (no I/O; app-kit never executes a
 * step). Every violation names the offending step id:
 *
 *   1. the array is non-empty when present;
 *   2. step ids are unique across `setup[]`;
 *   3. every `when.step` references an EARLIER step id;
 *   4. a step that declares `persist` declares EXACTLY one slot
 *      (`env` | `secret_slug` | `cmd` | `answer`);
 *   5. `choice.default` is the `value` of one of its own options;
 *   6. `persist.answer` is forbidden on a `type: secret` prompt — a
 *      secret MUST land in `secret_slug` or `env`.
 */
function validateSetupRule10(setup: readonly AppSetupStep[]): void {
  if (setup.length < 1) {
    throw new AppDefinitionError("'setup' must declare at least one step when present (AIP-53 rule 10).")
  }
  const ids = new Set<string>()
  for (const step of setup) {
    if (ids.has(step.id)) {
      throw new AppDefinitionError(
        `setup step '${step.id}' is declared more than once — step ids must be unique across 'setup[]' (AIP-53 rule 10).`,
      )
    }
    // `when.step` MUST name an EARLIER id — checked against the ids seen
    // so far, before this step joins them.
    if (step.when !== undefined && !ids.has(step.when.step)) {
      throw new AppDefinitionError(
        `setup step '${step.id}' has 'when.step' naming '${step.when.step}', which is not an EARLIER step id in 'setup[]' (AIP-53 rule 10).`,
      )
    }
    ids.add(step.id)

    const persist = setupPersistOf(step)
    if (persist !== undefined) {
      const slots = SETUP_PERSIST_SLOTS.filter(slot => persist[slot] !== undefined)
      if (slots.length !== 1) {
        throw new AppDefinitionError(
          `setup step '${step.id}' declares a 'persist' block with ${slots.length} slot${slots.length === 1 ? "" : "s"}${slots.length > 0 ? ` (${slots.join(", ")})` : ""} — exactly one slot (env | secret_slug | cmd | answer) is allowed (AIP-53 rule 10).`,
        )
      }
    }
    if (step.kind === "choice" && !step.options.some(o => o.value === step.default)) {
      throw new AppDefinitionError(
        `setup step '${step.id}' has default '${step.default}', which is not the value of one of its options (${step.options.map(o => o.value).join(", ")}) (AIP-53 rule 10).`,
      )
    }
    if (step.kind === "prompt" && step.type === "secret" && step.persist?.answer !== undefined) {
      throw new AppDefinitionError(
        `setup step '${step.id}' is a 'secret' prompt — 'persist.answer' MUST NOT be used with 'type: secret'; a secret MUST land in 'secret_slug' or 'env' (AIP-53 rule 10).`,
      )
    }
  }
}

/**
 * `ui.extensions` accepts ONLY the `openai` namespace (plan I8). Any other
 * vendor block is rejected with the exact field path rather than silently
 * carried and half-advertised downstream. Returns the `openai` value.
 */
function validateOpenAIExtensionsNamespace(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AppDefinitionError("`ui.extensions` must be an object.")
  }
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (key !== "openai") {
      throw new AppDefinitionError(
        `\`ui.extensions.${key}\` is not supported — \`extensions\` accepts only \`openai\` (v1).`,
      )
    }
  }
  return (raw as Record<string, unknown>).openai
}

const OPENAI_EXTENSION_KEYS = new Set(["entrypoints", "icons", "display", "mentions"])
/** Cut in v1: forms/elicitation+MRTR, plugin settings, resource writes,
 *  raw local-file opening, plugin onboarding manifest, deep links. Any of
 *  these keys (or anything unknown) fails with the exact field path. */
const OPENAI_CUT_KEY_MESSAGE =
  "is not a supported OpenAI extension field in v1 (cut would be silently half-advertised)"

const DOT_EXTENSION_RE = /^\.[a-z0-9][a-z0-9._+-]{0,31}$/
const OPENAI_MODES = ["inline", "fullscreen"] as const

/**
 * The single `ui.extensions.openai` validator/normalizer, shared by TS
 * authoring (`defineApp`) and manifest loading (`loadAppHandle` re-runs
 * through `defineApp`), so there is no hand-maintained duplicate. Normalizes
 * file entrypoint extensions to lowercase; validates every shape/range rule
 * with the exact `ui.extensions.openai.*` field path.
 */
export function normalizeOpenAIUiExtension(
  raw: unknown,
  tools: readonly string[] | undefined,
  fail: (message: string) => Error,
): OpenAIAppUiExtension | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw fail("`ui.extensions.openai` must be an object.")
  }
  for (const key of Object.keys(raw)) {
    if (!OPENAI_EXTENSION_KEYS.has(key)) {
      throw fail(`\`ui.extensions.openai.${key}\` ${OPENAI_CUT_KEY_MESSAGE}.`)
    }
  }

  const entrypoints = normalizeOpenAIEntrypoints((raw as Record<string, unknown>).entrypoints, fail)
  const icons = normalizeOpenAIIcons((raw as Record<string, unknown>).icons, fail)
  const display = normalizeOpenAIDisplay((raw as Record<string, unknown>).display, fail)
  const mentions = normalizeOpenAIMentions((raw as Record<string, unknown>).mentions, tools, fail)

  return {
    ...(entrypoints !== undefined ? { entrypoints } : {}),
    ...(icons !== undefined ? { icons } : {}),
    ...(display !== undefined ? { display } : {}),
    ...(mentions !== undefined ? { mentions } : {}),
  }
}

function normalizeOpenAIEntrypoints(
  raw: unknown,
  fail: (message: string) => Error,
): readonly OpenAIEntrypoint[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    throw fail("`ui.extensions.openai.entrypoints` must be an array.")
  }
  if (raw.length < 1 || raw.length > 3) {
    throw fail(
      `\`ui.extensions.openai.entrypoints\` must contain 1..3 entries, got ${raw.length}.`,
    )
  }
  const seenTypes = new Set<string>()
  const out: OpenAIEntrypoint[] = []
  for (let i = 0; i < raw.length; i++) {
    const path = `ui.extensions.openai.entrypoints[${i}]`
    const ep = raw[i]
    if (typeof ep !== "object" || ep === null || Array.isArray(ep)) {
      throw fail(`\`${path}\` must be an object.`)
    }
    const keys = Object.keys(ep as Record<string, unknown>)
    const invalidKeys = keys.filter(k => k !== "type" && k !== "extensions")
    if (invalidKeys.length > 0) {
      throw fail(
        `\`${path}.${invalidKeys[0]}\` is not a supported \`${(ep as { type?: unknown }).type}\` entrypoint field.`,
      )
    }
    const type = (ep as Record<string, unknown>).type
    if (type !== "global" && type !== "thread" && type !== "file") {
      throw fail(`\`${path}.type\` must be "global", "thread" or "file", got ${JSON.stringify(type)}.`)
    }
    if (seenTypes.has(type)) {
      throw fail(`\`ui.extensions.openai.entrypoints\` declares \`${type}\` more than once.`)
    }
    seenTypes.add(type)
    if (type === "file") {
      out.push({ type, extensions: normalizeDotExtensions((ep as Record<string, unknown>).extensions, path, fail) })
    } else {
      out.push({ type })
    }
  }
  return out
}

function normalizeDotExtensions(
  raw: unknown,
  path: string,
  fail: (message: string) => Error,
): readonly `.${string}`[] {
  if (!Array.isArray(raw)) {
    throw fail(`\`${path}.extensions\` must be an array of dot-prefixed strings.`)
  }
  if (raw.length < 1 || raw.length > 32) {
    throw fail(`\`${path}.extensions\` must contain 1..32 entries, got ${raw.length}.`)
  }
  const seen = new Set<string>()
  const out: `.${string}`[] = []
  for (let i = 0; i < raw.length; i++) {
    const ext = raw[i]
    if (typeof ext !== "string" || ext.trim() === "") {
      throw fail(`\`${path}.extensions[${i}]\` must be a non-empty string.`)
    }
    const normalized = ext.toLowerCase()
    if (seen.has(normalized)) {
      throw fail(`\`${path}.extensions\` declares '${normalized}' more than once.`)
    }
    seen.add(normalized)
    if (!DOT_EXTENSION_RE.test(normalized)) {
      throw fail(
        `\`${path}.extensions[${i}]\` ('${ext}') must be a dot-prefixed lowercase suffix matching /^\\.[a-z0-9][a-z0-9._+-]{0,31}$/, e.g. '.md'.`,
      )
    }
    out.push(normalized as `.${string}`)
  }
  return out
}

function normalizeOpenAIIcons(
  raw: unknown,
  fail: (message: string) => Error,
): readonly OpenAIIcon[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw fail("`ui.extensions.openai.icons` must be an array.")
  if (raw.length < 1) {
    throw fail("`ui.extensions.openai.icons` must contain at least one icon when present.")
  }
  return raw.map((icon, i) => {
    const path = `ui.extensions.openai.icons[${i}]`
    if (typeof icon !== "object" || icon === null || Array.isArray(icon)) {
      throw fail(`\`${path}\` must be an object.`)
    }
    const keys = Object.keys(icon as Record<string, unknown>)
    for (const key of keys) {
      if (key !== "src" && key !== "mimeType" && key !== "sizes" && key !== "theme") {
        throw fail(`\`${path}.${key}\` is not a supported icon field.`)
      }
    }
    const src = (icon as Record<string, unknown>).src
    if (typeof src !== "string" || src.trim() === "") {
      throw fail(`\`${path}.src\` must be a non-empty string.`)
    }
    if (!(ICON_SRC_HTTPS_RE.test(src) || hasValidIconSrcDataUrl(src))) {
      throw fail(
        `\`${path}.src\` must be an HTTPS URL or a 'data:image/…;base64,…' URL (inline SVG data allowed), got '${src.slice(0, 64)}'.`,
      )
    }
    const mimeType = (icon as Record<string, unknown>).mimeType
    if (mimeType !== undefined && (typeof mimeType !== "string" || mimeType.trim() === "")) {
      throw fail(`\`${path}.mimeType\` must be a non-empty string when present.`)
    }
    const sizes = (icon as Record<string, unknown>).sizes
    if (
      sizes !== undefined &&
      (!Array.isArray(sizes) || (sizes as unknown[]).length === 0 ||
        !(sizes as unknown[]).every((s) => typeof s === "string" && s.trim() !== ""))
    ) {
      throw fail(`\`${path}.sizes\` must be an array of non-empty strings when present.`)
    }
    const theme = (icon as Record<string, unknown>).theme
    if (theme !== undefined && theme !== "light" && theme !== "dark") {
      throw fail(`\`${path}.theme\` must be "light" or "dark" when present, got ${JSON.stringify(theme)}.`)
    }
    return {
      src,
      ...(mimeType !== undefined ? { mimeType: mimeType as string } : {}),
      ...(sizes !== undefined ? { sizes: Object.freeze([...(sizes as string[])]) } : {}),
      ...(theme !== undefined ? { theme: theme as "light" | "dark" } : {}),
    }
  })
}

const ICON_SRC_HTTPS_RE = /^https:\/\/\S+$/

function hasValidIconSrcDataUrl(src: string): boolean {
  const comma = src.indexOf(",")
  if (comma < 0) return false
  const header = src.slice(0, comma)
  const payload = src.slice(comma + 1)
  if (!/^data:image\/[a-z0-9.+-]+(?:;charset=[\w-]+)?(?:;base64|;utf8)?$/i.test(header)) return false
  if (/;base64$/i.test(header)) return /^[A-Za-z0-9+/=\r\n]+$/.test(payload)
  return payload.trim() !== ""
}

function normalizeOpenAIDisplay(
  raw: unknown,
  fail: (message: string) => Error,
):
  | { readonly availableModes?: readonly ("inline" | "fullscreen")[]
      readonly preferredMode?: "inline" | "fullscreen" }
  | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw fail("`ui.extensions.openai.display` must be an object.")
  }
  const availableModes = (raw as Record<string, unknown>).availableModes
  if (availableModes !== undefined) {
    if (!Array.isArray(availableModes) || availableModes.length === 0) {
      throw fail("`ui.extensions.openai.display.availableModes` must be a non-empty array when present.")
    }
    const seen = new Set<string>()
    for (const mode of availableModes) {
      if (mode !== "inline" && mode !== "fullscreen") {
        throw fail(
          `\`ui.extensions.openai.display.availableModes\` supports only "inline" and "fullscreen", got ${JSON.stringify(mode)}.`,
        )
      }
      if (seen.has(mode)) {
        throw fail(`\`ui.extensions.openai.display.availableModes\` declares '${mode}' more than once.`)
      }
      seen.add(mode)
    }
  }
  const preferredMode = (raw as Record<string, unknown>).preferredMode
  if (
    preferredMode !== undefined &&
    !(OPENAI_MODES as readonly unknown[]).includes(preferredMode)
  ) {
    throw fail(
      `\`ui.extensions.openai.display.preferredMode\` must be "inline" or "fullscreen", got ${JSON.stringify(preferredMode)}.`,
    )
  }
  if (
    availableModes !== undefined &&
    preferredMode !== undefined &&
    !availableModes.includes(preferredMode as "inline" | "fullscreen")
  ) {
    throw fail(
      `\`ui.extensions.openai.display.preferredMode\` ('${preferredMode}') must occur in \`ui.extensions.openai.display.availableModes\` when both are declared.`,
    )
  }
  return {
    ...(availableModes !== undefined
      ? { availableModes: Object.freeze([...(availableModes as ("inline" | "fullscreen")[])]) }
      : {}),
    ...(preferredMode !== undefined ? { preferredMode: preferredMode as "inline" | "fullscreen" } : {}),
  }
}

function normalizeOpenAIMentions(
  raw: unknown,
  tools: readonly string[] | undefined,
  fail: (message: string) => Error,
):
  | { readonly searchTool: string }
  | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw fail("`ui.extensions.openai.mentions` must be an object.")
  }
  for (const key of Object.keys(raw)) {
    if (key !== "searchTool") {
      throw fail(`\`ui.extensions.openai.mentions.${key}\` is not a supported mentions field.`)
    }
  }
  const searchTool = (raw as Record<string, unknown>).searchTool
  if (typeof searchTool !== "string" || searchTool.trim() === "") {
    throw fail("`ui.extensions.openai.mentions.searchTool` must be a non-empty string.")
  }
  if (tools === undefined || !tools.includes(searchTool)) {
    throw fail(
      `\`ui.extensions.openai.mentions.searchTool\` '${searchTool}' must be declared in this same ui block's \`tools\`${tools ? ` (${tools.join(", ")})` : " — the ui declares none"}.`,
    )
  }
  return { searchTool }
}

/** Deep-freeze the normalized OpenAI extension tree — same immutability
 *  discipline the rest of app-kit applies to top-level handle fields. */
function freezeDeep(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeep))
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      out[key] = freezeDeep(v)
    }
    return Object.freeze(out)
  }
  return value
}

export type { DoctypeHandle }
