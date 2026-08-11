/**
 * Types for `@agentproto/app-kit`.
 *
 * An "app" is the smallest shippable unit that couples one or more AIP-42
 * agents with the AIP-15 workflows they run — plus any other AIP artifacts
 * you want to ride along (an AIP-6 company, AIP-25 personas, AIP-47 roles,
 * policies…). The agents and workflows are authored with the existing
 * `defineAgent` / `defineWorkflow`; app-kit bundles + cross-links them.
 *
 * On the system prompt: there is no `systemPrompt` field anywhere in AIP.
 * The prompt is the free-text BODY of an AGENT.md (AIP-42) — frontmatter is
 * `.strict()` and holds only metadata. So each agent carries an optional
 * `body`; when omitted the prompt composes from the agent's persona /
 * boundaries / traits (`composeInstructions` falls back to `description`),
 * the same way Guilde assembles an operator's prompt from AIP-47 role
 * instructions + AIP-25 persona rather than a stored string.
 */

import type { AgentHandle } from "@agentproto/agent"
import type { WorkflowHandle } from "@agentproto/workflow"
import type { WorkspaceHandle, WorkspaceDefinition } from "@agentproto/workspace"
import type { BuildMastraAgentResult, BuildMastraAgentOptions } from "@agentproto/mastra"

/**
 * An agent paired with the prose that becomes its system prompt. `body`
 * is the AGENT.md body (AIP-42) — the only place free-text instructions
 * live. Optional: omit it to let the prompt compose from the agent's
 * structured fields.
 */
export interface AgentEntry {
  readonly agent: AgentHandle
  /** The AGENT.md body / system prompt. Optional — composed if absent. */
  readonly body?: string
}

/**
 * Structural view of any AIP doctype handle (agent, company, persona,
 * role, policy…). Every `defineX` handle has a stable `id`; `schema`
 * carries the doctype literal when the doctype declares one. Kept
 * structural so an app can `attach` any AIP artifact without app-kit
 * depending on each doctype package.
 */
export interface DoctypeHandle {
  readonly id: string
  readonly schema?: string
}

/**
 * Lightweight way to give an app a home workspace without hand-writing a
 * full AIP-34 `defineWorkspace(...)`. `owner` is the tenant identity
 * (guild / user / org — the tenant model AIP-34 already ships, not a folder
 * segment); `storage` is the AIP-35 STORAGE block and defaults to local
 * filesystem. `id` is the globally-addressable `@<owner-slug>/<workspace>`,
 * whose owner segment MUST equal `owner.slug`.
 */
export interface WorkspaceShorthand {
  readonly id: string
  readonly name: string
  readonly owner: WorkspaceDefinition["owner"]
  /** AIP-35 STORAGE block. Defaults to `{ inline: { provider: "local-fs", config: {} } }`. */
  readonly storage?: WorkspaceDefinition["storage"]
  readonly version?: string
  readonly description?: string
}

/**
 * A home workspace for an app: either a full AIP-34 `WorkspaceHandle`
 * (from `defineWorkspace`) or the `WorkspaceShorthand` above. Discriminated
 * structurally — a built handle carries `schema: "workspace/v1"`.
 */
export type WorkspaceInput = WorkspaceHandle | WorkspaceShorthand

/**
 * A single HTML surface an app ships alongside its agents — the artifact a
 * host renders (e.g. an embedded panel). `html` is the full document; `emit`
 * writes it to `.agentproto/ui/index.html` rather than inlining it into the
 * APP.md frontmatter.
 */
export interface AppUiDefinition {
  readonly html: string
  readonly title?: string
  readonly description?: string
  readonly tools?: readonly string[]
  readonly csp?: {
    readonly connectDomains?: readonly string[]
    readonly resourceDomains?: readonly string[]
  }
}

/**
 * A persistent HTML dashboard (Cowork artifact) the app ships alongside its
 * agents. `path` is the absolute path to the HTML file; `emit` copies it to
 * `.agentproto/artifact/index.html`. The daemon exposes the content via
 * `app_artifact_get` — the host agent (Cowork) calls `create_artifact` with
 * it, never writes the host manifest directly.
 */
export interface AppArtifactSurface {
  readonly path: string
  readonly title?: string
  readonly description?: string
}

/** A kind of artifact the app's agents may produce, declared for discovery. */
export interface AppArtifactDecl {
  readonly type: string
  readonly description?: string
}

/** One way to launch the app for local development. */
export interface AppDevLaunchConfig {
  readonly name: string
  readonly runtimeExecutable: string
  readonly runtimeArgs?: readonly string[]
  readonly port?: number
  readonly url?: string
}

/** Dev-launch configuration for the app, carried verbatim in APP.md frontmatter. */
export interface AppDevDefinition {
  readonly launch: readonly AppDevLaunchConfig[]
}

/**
 * Input to `defineApp`. Each `agents[]` entry is an already-validated
 * `AgentHandle` (bare, no body) or an `AgentEntry` (handle + body).
 */
export interface AppDefinition {
  readonly agents: readonly (AgentEntry | AgentHandle)[]
  readonly workflows?: readonly WorkflowHandle[]
  /** Any other AIP handles to carry with the app (AIP-6/25/47/…). */
  readonly attach?: readonly DoctypeHandle[]
  /**
   * Optional home workspace (AIP-34). When set, the app is content
   * *inside* a workspace whose `owner` names the tenant and whose
   * `storage` names the backing store — `emit` writes a root `WORKSPACE.md`
   * alongside the agents. Omit for a workspace-less bundle.
   */
  readonly workspace?: WorkspaceInput
  /**
   * Machine identifier for the app itself (distinct from its agents' ids).
   * Must be non-empty when present. Setting it is what makes the app
   * discoverable — `emit` writes it into the root `APP.md` identity block.
   */
  readonly id?: string
  /** Human-readable app name. */
  readonly name?: string
  /** App version. Defaults to `"0.1.0"` when `id` is set. */
  readonly version?: string
  /** App description. Becomes the `APP.md` body. */
  readonly description?: string
  /** APP ids this app depends on. */
  readonly requires?: readonly string[]
  /** An HTML surface the app ships alongside its agents. */
  readonly ui?: AppUiDefinition
  /** A persistent HTML dashboard (Cowork artifact) the app ships. `path`
   *  must be an absolute path to an HTML file on disk — `emit` copies it into
   *  the bundle. */
  readonly artifact?: AppArtifactSurface
  /** Artifact types this app's agents may produce, declared for discovery. */
  readonly artifacts?: readonly AppArtifactDecl[]
  /** Dev-launch configuration for running the app locally. */
  readonly dev?: AppDevDefinition
}

/** Options for `toMastraAgent(s)`. Same resolvers as `buildMastraAgent`. */
export type ToMastraAgentOptions = BuildMastraAgentOptions

/** Paths written by `AppHandle.emit`. */
export interface EmittedApp {
  /** Absolute paths to the written `AGENT.md` files, keyed by agent id. */
  readonly agentPaths: Readonly<Record<string, string>>
  /** Absolute paths to the written `WORKFLOW.md` files, in input order. */
  readonly workflowPaths: readonly string[]
  /** Absolute path to the root `WORKSPACE.md`, when the app has a workspace. */
  readonly workspacePath?: string
  /** Absolute path to the root `APP.md` index, always written. */
  readonly appPath: string
  /** Absolute path to the written `.agentproto/ui/index.html`, when the app has a `ui`. */
  readonly uiPath?: string
  /** Absolute path to the written `.agentproto/artifact/index.html`, when the app has an `artifact`. */
  readonly artifactPath?: string
}

/**
 * The frozen result of `defineApp`. Carries the cross-linked agents +
 * workflows + attachments and the two consumption paths.
 */
export interface AppHandle {
  readonly agents: readonly AgentEntry[]
  readonly workflows: readonly WorkflowHandle[]
  readonly attachments: readonly DoctypeHandle[]
  /** The app's home workspace (AIP-34), normalized to a handle. Absent if none. */
  readonly workspace?: WorkspaceHandle
  /** Machine identifier for the app itself. Absent for an anonymous bundle. */
  readonly id?: string
  /** Human-readable app name. */
  readonly name?: string
  /** App version. Defaulted to `"0.1.0"` when `id` is set. */
  readonly version?: string
  /** App description. */
  readonly description?: string
  /** APP ids this app depends on. */
  readonly requires?: readonly string[]
  /** An HTML surface the app ships alongside its agents. */
  readonly ui?: AppUiDefinition
  /** A persistent HTML dashboard (Cowork artifact) the app ships. */
  readonly artifact?: AppArtifactSurface
  /** Artifact types this app's agents may produce, declared for discovery. */
  readonly artifacts?: readonly AppArtifactDecl[]
  /** Dev-launch configuration for running the app locally. */
  readonly dev?: AppDevDefinition

  /**
   * Build agents into runnable Mastra agents whose `instructions` field is
   * the real system prompt (body → `composeInstructions`), keyed by agent id.
   *
   * Pass `only` to build just those agent ids instead of the whole app — the
   * "use n of a team" path, so a host doesn't pay to build agents it won't
   * run. Every id in `only` must belong to the app (unknown ids throw).
   */
  toMastraAgents(
    opts: ToMastraAgentOptions,
    only?: readonly string[],
  ): Promise<Record<string, BuildMastraAgentResult>>

  /**
   * Select a subset of the app's agents by id, as a fresh readonly list —
   * without building them. Throws `AppDefinitionError` on an unknown id.
   * Handy to inspect or hand-pick before `toMastraAgents`.
   */
  pick(ids: readonly string[]): readonly AgentEntry[]

  /**
   * Single-agent convenience. Throws if the app has zero or more than
   * one agent — use `toMastraAgents` for multi-agent apps.
   */
  toMastraAgent(opts: ToMastraAgentOptions): Promise<BuildMastraAgentResult>

  /**
   * Write one `AGENT.md` per agent + one shared `WORKFLOW.md` per workflow
   * under `<dir>/.agentproto/`, plus a root `<dir>/WORKSPACE.md` when the
   * app has a `workspace`. Returns the written paths.
   */
  emit(dir: string): Promise<EmittedApp>
}
