/**
 * `buildMastraAgent(handle, opts)` — turn an AIP-42 AGENT.md handle
 * into a runnable `new Agent({ ... })` from `@mastra/core/agent`.
 *
 * The function is intentionally narrow: it walks the manifest's
 * structural fields and calls user-supplied resolvers for everything
 * that needs runtime knowledge (model, tools, workflows, memory,
 * voice). Anything the resolvers can't translate is either dropped
 * with a warning (default) or throws (`strict: true`).
 */

import { Agent } from "@mastra/core/agent"
import type { AgentHandle, AnyRef } from "@agentproto/agent"
import { composeInstructions } from "./instructions.js"
import type {
  BuildMastraAgentOptions,
  BuildMastraAgentResult,
  ToolResolver,
  WorkflowResolver,
  MastraToolLike,
} from "./types.js"

export async function buildMastraAgent(
  handle: AgentHandle,
  opts: BuildMastraAgentOptions,
): Promise<BuildMastraAgentResult> {
  const formatInstructions = opts.formatInstructions ?? composeInstructions
  const instructions = formatInstructions(handle, opts.body)
  const model = await opts.resolveModel(handle.model)

  const { tools, resolvedTools, droppedTools } = await resolveTools(
    handle.tools,
    opts.resolveTool,
    { strict: opts.strict ?? false, agentId: handle.id },
  )

  const { resolvedWorkflows, droppedWorkflows } = await resolveWorkflows(
    handle.workflows,
    opts.resolveWorkflow,
    { strict: opts.strict ?? false, agentId: handle.id },
  )

  const memory = opts.buildMemory && handle.memory
    ? await opts.buildMemory(handle.memory)
    : undefined

  const voice = opts.buildVoice ? await opts.buildVoice(handle) : undefined

  const name = opts.name ?? stripOwner(handle.id)
  const id = opts.id ?? handle.id

  // Mastra's Agent ctor types are heterogeneous (model union, tools
  // record etc.) and have generic-variance issues that leak through
  // structuredOutput inference; we widen at both ends so the package
  // stays independent of @mastra/core's internal generic shape.
  const agent = new Agent({
    name,
    id,
    instructions,
    model,
    tools,
    memory,
    voice,
  } as unknown as ConstructorParameters<typeof Agent>[0]) as unknown as Agent

  return {
    agent,
    resolvedTools,
    droppedTools,
    resolvedWorkflows,
    droppedWorkflows,
    instructions,
  }
}

interface ResolveToolsCtx {
  strict: boolean
  agentId: string
}

async function resolveTools(
  refs: AnyRef[] | undefined,
  resolve: ToolResolver | undefined,
  ctx: ResolveToolsCtx,
): Promise<{
  tools: Record<string, MastraToolLike>
  resolvedTools: string[]
  droppedTools: string[]
}> {
  const tools: Record<string, MastraToolLike> = {}
  const resolvedTools: string[] = []
  const droppedTools: string[] = []

  if (!refs || refs.length === 0) return { tools, resolvedTools, droppedTools }

  if (!resolve) {
    if (ctx.strict) {
      throw new Error(
        `buildMastraAgent: agent '${ctx.agentId}' declares ${refs.length} tool(s) but no resolveTool was provided`,
      )
    }
    console.warn(
      `[@agentproto/mastra] agent '${ctx.agentId}' declares ${refs.length} tool(s) but no resolveTool was provided — skipping`,
    )
    refs.forEach((r) => droppedTools.push(refKey(r)))
    return { tools, resolvedTools, droppedTools }
  }

  for (const ref of refs) {
    const resolved = await resolve(ref)
    if (!resolved) {
      droppedTools.push(refKey(ref))
      if (ctx.strict) {
        throw new Error(
          `buildMastraAgent: agent '${ctx.agentId}' tool '${refKey(ref)}' did not resolve`,
        )
      }
      console.warn(
        `[@agentproto/mastra] agent '${ctx.agentId}' tool '${refKey(ref)}' did not resolve — skipping`,
      )
      continue
    }
    tools[resolved.name] = resolved.tool
    resolvedTools.push(resolved.name)
  }

  return { tools, resolvedTools, droppedTools }
}

async function resolveWorkflows(
  refs: AnyRef[] | undefined,
  resolve: WorkflowResolver | undefined,
  ctx: ResolveToolsCtx,
): Promise<{ resolvedWorkflows: string[]; droppedWorkflows: string[] }> {
  const resolvedWorkflows: string[] = []
  const droppedWorkflows: string[] = []

  if (!refs || refs.length === 0) {
    return { resolvedWorkflows, droppedWorkflows }
  }
  if (!resolve) {
    refs.forEach((r) => droppedWorkflows.push(refKey(r)))
    return { resolvedWorkflows, droppedWorkflows }
  }

  for (const ref of refs) {
    const resolved = await resolve(ref)
    if (!resolved) {
      droppedWorkflows.push(refKey(ref))
      if (ctx.strict) {
        throw new Error(
          `buildMastraAgent: agent '${ctx.agentId}' workflow '${refKey(ref)}' did not resolve`,
        )
      }
      continue
    }
    resolvedWorkflows.push(resolved.name)
  }

  return { resolvedWorkflows, droppedWorkflows }
}

function refKey(ref: AnyRef): string {
  if (typeof ref === "string") return ref
  return ref.ref ?? ref.file ?? JSON.stringify(ref.inline ?? ref)
}

function stripOwner(id: string): string {
  // `@agentik/writer` → `writer`; bare ids untouched.
  const m = id.match(/^@[^/]+\/(.+)$/)
  return m ? m[1]! : id
}
