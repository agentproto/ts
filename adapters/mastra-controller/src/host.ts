/**
 * `createAgentControllerHost`: turns a parsed `mastra.agent-controller/v1`
 * manifest into a live `AgentControllerConfig` / `AgentController`.
 *
 * Portable fields are copied as is. Every host-resolved field (an opaque
 * `{ $resolver, ... }` reference, see `./manifest.ts`) is handed to the
 * resolver the host registered under that `$resolver` name; a reference
 * whose name has no registered resolver fails with
 * {@link UnresolvedReferenceError}, naming the field path.
 *
 * What each resolved value becomes:
 *
 *   | manifest field        | resolver must return            | config field             |
 *   | --------------------- | ------------------------------- | ------------------------ |
 *   | `storage`             | `MastraCompositeStore`          | `storage`                |
 *   | `memory`              | `MastraMemory` (or a factory)   | `memory`                 |
 *   | `workspace`           | `Workspace` (or a factory)      | `workspace`              |
 *   | `agent`               | `Agent`                         | `agent`                  |
 *   | `tools`               | `ToolsInput` (or a factory)     | `tools`                  |
 *   | `models.resolver`     | `(modelId) => model`            | backing agent's model    |
 *   | `modes[].agent`       | `Agent`                         | `modes[].agent`          |
 *   | `modes[].model`       | model id string                 | `modes[].defaultModelId` |
 *   | `modes[].tools`       | `ToolsInput`                    | `modes[].tools`          |
 *   | `subagents[].model`   | model id string                 | `subagents[].defaultModelId` |
 *   | `subagents[].tools`   | `ToolsInput`                    | `subagents[].tools`      |
 *
 * `subagents[].agent` has no `AgentControllerSubagent` counterpart and is
 * rejected rather than silently dropped.
 *
 * Defaults when the manifest leaves a field out:
 *
 *   - storage: `InMemoryStore` from `@mastra/core/storage`. `@mastra/core`
 *     ships no libsql store (that is `@mastra/libsql`), so threads live as
 *     long as the controller; a host wanting durable threads registers a
 *     `storage` resolver or passes `defaults.storage`.
 *   - backing agent: an inline `Agent` named after the manifest, whose model
 *     is the session's current model id (the mode's `defaultModelId` on
 *     entry), turned into a model by `models.resolver`, then
 *     `defaults.resolveModel`, else handed to Mastra's model router as is.
 *     Mode `instructions` are layered on top by the controller.
 *   - memory: none.
 */

import { createRequire } from "node:module"
import { Agent } from "@mastra/core/agent"
import {
  AgentController,
  type AgentControllerConfig,
  type AgentControllerMode,
  type AgentControllerSubagent,
} from "@mastra/core/agent-controller"
import { InMemoryStore } from "@mastra/core/storage"
import type { ControllerManifest, ResolverRef } from "./manifest.js"

/** What a resolver receives besides the reference itself. */
export interface ResolverContext {
  /** Dotted path of the field being resolved, e.g. `modes.0.agent`. */
  path: string
  manifest: ControllerManifest
  /** Session working directory, when the client knows it. */
  cwd?: string
  /** Session env, when the client knows it. */
  env?: Record<string, string>
}

export type ControllerResolver = (ref: ResolverRef, ctx: ResolverContext) => unknown

/** A model the backing agent can run: whatever `new Agent({ model })` takes. */
export type ControllerModel = ConstructorParameters<typeof Agent>[0]["model"]

export interface AgentControllerHostDefaults {
  /** Storage when the manifest has no `storage` reference. Default: `InMemoryStore`. */
  storage?: () => AgentControllerConfig["storage"] | Promise<AgentControllerConfig["storage"]>
  /** Turns a model id into a model when the manifest has no `models.resolver`. */
  resolveModel?: (modelId: string) => ControllerModel
  /** Instructions of the inline backing agent. Default: the manifest's `description`. */
  instructions?: string
}

export interface AgentControllerHostOptions {
  /** `$resolver` name to resolver. */
  resolvers?: Record<string, ControllerResolver>
  defaults?: AgentControllerHostDefaults
}

export interface AgentControllerHost {
  buildConfig(
    manifest: ControllerManifest,
    ctx?: Omit<ResolverContext, "path" | "manifest">,
  ): Promise<AgentControllerConfig>
  /** `buildConfig` + `new AgentController(config)` + `init()`. */
  createController(
    manifest: ControllerManifest,
    ctx?: Omit<ResolverContext, "path" | "manifest">,
  ): Promise<AgentController>
}

export class UnresolvedReferenceError extends Error {
  readonly path: string
  readonly resolver: string

  constructor(path: string, resolver: string) {
    super(
      `mastra-controller: ${path} references $resolver '${resolver}', but no resolver is ` +
        "registered under that name. Pass it in createAgentControllerHost({ resolvers }).",
    )
    this.name = "UnresolvedReferenceError"
    this.path = path
    this.resolver = resolver
  }
}

export class ResolvedValueError extends Error {
  readonly path: string

  constructor(path: string, expected: string, got: unknown) {
    super(
      `mastra-controller: resolver for ${path} must return ${expected}, got ${describe(got)}`,
    )
    this.name = "ResolvedValueError"
    this.path = path
  }
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return typeof value
}

/** Lowest `@mastra/core` whose approval gate does not re-run on a tool resuming from its own `suspend()`. */
export const MIN_MASTRA_CORE_VERSION = "1.60.0"

export class UnsupportedMastraCoreError extends Error {
  readonly installed: string
  readonly minimum: string

  constructor(installed: string, minimum: string) {
    super(
      `mastra-controller: @mastra/core ${installed} is installed but ${minimum} or newer is ` +
        "required: older versions re-run the approval gate on a tool resuming from its own " +
        "suspend(), so rejected plans lose their feedback and approved self-suspended tools " +
        "never resume. Upgrade @mastra/core.",
    )
    this.name = "UnsupportedMastraCoreError"
    this.installed = installed
    this.minimum = minimum
  }
}

function parseVersion(version: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

/** Throws when `installed` is older than `minimum`; an unparseable version is let through. */
export function assertMastraCoreVersion(
  installed: string,
  minimum: string = MIN_MASTRA_CORE_VERSION,
): void {
  const have = parseVersion(installed)
  const need = parseVersion(minimum)
  if (!have || !need) return
  for (let i = 0; i < 3; i++) {
    if (have[i]! > need[i]!) return
    if (have[i]! < need[i]!) throw new UnsupportedMastraCoreError(installed, minimum)
  }
}

function installedMastraCoreVersion(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url)("@mastra/core/package.json") as { version?: unknown }
    return typeof pkg.version === "string" ? pkg.version : undefined
  } catch {
    return undefined
  }
}

export function createAgentControllerHost(
  options: AgentControllerHostOptions = {},
): AgentControllerHost {
  const installed = installedMastraCoreVersion()
  if (installed !== undefined) assertMastraCoreVersion(installed)
  const resolvers = options.resolvers ?? {}
  const defaults = options.defaults ?? {}

  async function buildConfig(
    manifest: ControllerManifest,
    base: Omit<ResolverContext, "path" | "manifest"> = {},
  ): Promise<AgentControllerConfig> {
    async function resolve(ref: ResolverRef | undefined, path: string): Promise<unknown> {
      if (ref === undefined) return undefined
      const resolver = resolvers[ref.$resolver]
      if (!resolver) throw new UnresolvedReferenceError(path, ref.$resolver)
      return await resolver(ref, { ...base, path, manifest })
    }
    async function resolveModelId(
      ref: ResolverRef | undefined,
      path: string,
    ): Promise<string | undefined> {
      const value = await resolve(ref, path)
      if (value === undefined) return undefined
      if (typeof value !== "string" || !value) {
        throw new ResolvedValueError(path, "a model id string", value)
      }
      return value
    }

    // Resolve in document order so the first missing resolver reported is
    // the first one a reader meets in the manifest.
    const storage = await resolve(manifest.storage, "storage")
    const memory = await resolve(manifest.memory, "memory")
    const workspace = await resolve(manifest.workspace, "workspace")
    const agent = await resolve(manifest.agent, "agent")
    const tools = await resolve(manifest.tools, "tools")
    const modelResolver = await resolve(manifest.models?.resolver, "models.resolver")
    if (modelResolver !== undefined && typeof modelResolver !== "function") {
      throw new ResolvedValueError("models.resolver", "a (modelId) => model function", modelResolver)
    }
    if (agent !== undefined && !(agent instanceof Agent)) {
      throw new ResolvedValueError("agent", "a Mastra Agent", agent)
    }

    const modes: AgentControllerMode[] = []
    for (const [i, mode] of manifest.modes.entries()) {
      const modeAgent = await resolve(mode.agent, `modes.${i}.agent`)
      if (modeAgent !== undefined && !(modeAgent instanceof Agent)) {
        throw new ResolvedValueError(`modes.${i}.agent`, "a Mastra Agent", modeAgent)
      }
      const modelId = await resolveModelId(mode.model, `modes.${i}.model`)
      const modeTools = await resolve(mode.tools, `modes.${i}.tools`)
      modes.push({
        id: mode.id,
        ...(mode.name !== undefined ? { name: mode.name } : {}),
        ...(mode.description !== undefined ? { description: mode.description } : {}),
        ...(mode.default !== undefined ? { default: mode.default } : {}),
        ...(mode.transitionsTo !== undefined ? { transitionsTo: mode.transitionsTo } : {}),
        ...((modelId ?? mode.defaultModelId) !== undefined
          ? { defaultModelId: (modelId ?? mode.defaultModelId)! }
          : {}),
        ...(mode.instructions !== undefined ? { instructions: mode.instructions } : {}),
        ...(mode.availableTools !== undefined ? { availableTools: mode.availableTools } : {}),
        ...(mode.metadata !== undefined ? { metadata: mode.metadata } : {}),
        ...(modeAgent !== undefined ? { agent: modeAgent as Agent } : {}),
        ...(modeTools !== undefined ? { tools: modeTools as never } : {}),
      })
    }

    const subagents: AgentControllerSubagent[] = []
    for (const [i, sub] of (manifest.subagents ?? []).entries()) {
      if (sub.agent !== undefined) {
        throw new ResolvedValueError(
          `subagents.${i}.agent`,
          "nothing: an AgentController subagent has no backing-agent field",
          sub.agent,
        )
      }
      const modelId = await resolveModelId(sub.model, `subagents.${i}.model`)
      const subTools = await resolve(sub.tools, `subagents.${i}.tools`)
      subagents.push({
        id: sub.id,
        name: sub.name,
        description: sub.description,
        instructions: sub.instructions ?? "",
        ...((modelId ?? sub.defaultModelId) !== undefined
          ? { defaultModelId: (modelId ?? sub.defaultModelId)! }
          : {}),
        ...(sub.maxSteps !== undefined ? { maxSteps: sub.maxSteps } : {}),
        ...(sub.forked !== undefined ? { forked: sub.forked } : {}),
        ...(sub.allowedControllerTools !== undefined
          ? { allowedControllerTools: sub.allowedControllerTools }
          : {}),
        ...(sub.allowedWorkspaceTools !== undefined
          ? { allowedWorkspaceTools: sub.allowedWorkspaceTools }
          : {}),
        ...(subTools !== undefined ? { tools: subTools as never } : {}),
      })
    }

    const toModel =
      (modelResolver as ((modelId: string) => ControllerModel) | undefined) ??
      defaults.resolveModel
    const fallbackModelId =
      modes.find(m => m.default)?.defaultModelId ?? modes.find(m => m.defaultModelId)?.defaultModelId
    const backingAgent =
      (agent as Agent | undefined) ??
      (modes.every(m => m.agent !== undefined)
        ? undefined
        : new Agent({
            id: manifest.id,
            name: manifest.name,
            instructions:
              defaults.instructions ?? manifest.description ?? `You are ${manifest.name}.`,
            model: (({ requestContext }: { requestContext?: { get(key: string): unknown } }) => {
              const controller = requestContext?.get("controller") as
                | { session?: { modelId?: string } }
                | undefined
              const modelId = controller?.session?.modelId || fallbackModelId
              if (!modelId) {
                throw new Error(
                  `mastra-controller: manifest '${manifest.id}' gives the current mode no ` +
                    "defaultModelId, so the inline backing agent has no model to run",
                )
              }
              return toModel ? toModel(modelId) : modelId
            }) as never,
          }))

    return {
      id: manifest.id,
      modes,
      storage: ((storage as AgentControllerConfig["storage"]) ??
        (defaults.storage ? await defaults.storage() : new InMemoryStore())) as never,
      ...(memory !== undefined ? { memory: memory as never } : {}),
      ...(workspace !== undefined ? { workspace: workspace as never } : {}),
      ...(backingAgent !== undefined ? { agent: backingAgent } : {}),
      ...(tools !== undefined ? { tools: tools as never } : {}),
      ...(subagents.length ? { subagents } : {}),
      ...(manifest.omConfig !== undefined ? { omConfig: manifest.omConfig } : {}),
    }
  }

  return {
    buildConfig,
    async createController(manifest, ctx) {
      const controller = new AgentController(await buildConfig(manifest, ctx))
      await controller.init()
      return controller
    },
  }
}
