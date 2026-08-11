/**
 * Builds a runnable Mastra `AgentController` from an AIP-42 AGENT.md — either
 * a caller's file or a zero-config built-in default — wiring the model, the
 * markdown body as instructions, the SQLite memory/storage, and the workspace
 * toolset, then wrapping the built `Agent` as the controller's shared backing
 * agent. The ACP host drives controller sessions, not the raw agent stream.
 */

import { readFile } from "node:fs/promises"
import { agentFromManifest, parseAgentManifest } from "@agentproto/agent"
import { buildMastraAgent } from "@agentproto/mastra"
import type { MastraToolLike } from "@agentproto/mastra"
import { AgentController } from "@mastra/core/agent-controller"
import type {
  AgentControllerConfig,
  BuiltinToolId,
} from "@mastra/core/agent-controller"
import type { MastraMemoryLike } from "./memory.js"
import { buildSqliteMemory, buildSqliteStore } from "./memory.js"
import { resolveMastraModel } from "./model-resolver.js"
import { makeUnwiredToolStub, makeWorkspaceTools } from "./workspace-tools.js"

/** Cheap OpenRouter coder by default — this is the budget first-party arm,
 *  same rationale as the hermes default. Override with --model / env. */
export const DEFAULT_MODEL = "openrouter/z-ai/glm-5.2"

/** Tool ids the built-in default agent is granted (the workspace toolset). */
export const DEFAULT_TOOL_IDS = [
  "list_dir",
  "read_file",
  "write_file",
  "edit_file",
  "run_command",
] as const

export interface AgentSourceOptions {
  /** Path to an AGENT.md. When omitted, the built-in default agent is used. */
  agentFile?: string
  /** Model id for the default agent (ignored when agentFile carries a model). */
  model?: string
  /** Workspace dir the tools are confined to. Defaults to `process.cwd()`. */
  cwd?: string
  /** When false, the `run_command` tool is withheld. Default true. */
  allowExec?: boolean
  /**
   * Extra tools merged over the built-in workspace toolset (extra wins on id
   * collision) — programmatic-only, for a host embedding this agent that
   * wants to grant tools the built-in toolset doesn't cover. No CLI flag.
   */
  extraTools?: Record<string, MastraToolLike>
}

/** The built-in AGENT.md used when no file is supplied. */
export function defaultAgentManifest(model: string): string {
  return [
    "---",
    "schema: agent/v1",
    "id: mastra-agent",
    "description: A first-party agentproto agent powered by Mastra.",
    `model: ${model}`,
    "version: 0.1.0",
    "tools:",
    ...DEFAULT_TOOL_IDS.map((id) => `  - ${id}`),
    "memory:",
    "  scope: per-conversation",
    "  retention_turns: 20",
    "---",
    "",
    "You are a capable, concise coding agent operating inside a workspace ",
    "directory. You can list, read, write, and edit files and run shell ",
    "commands there using your tools. Do exactly what the user asks — when ",
    "asked to reply with an exact string, reply with only that string.",
    "",
  ].join("\n")
}

/** Pull the id string out of an AIP-42 tool ref (string | { ref }). */
function toolRefId(ref: unknown): string | undefined {
  if (typeof ref === "string") return ref
  if (ref && typeof ref === "object" && typeof (ref as { ref?: unknown }).ref === "string") {
    return (ref as { ref: string }).ref
  }
  return undefined
}

/** Resolve the AGENT.md source for these options (file or built-in default). */
export async function resolveAgentSource(
  opts: AgentSourceOptions = {},
): Promise<string> {
  if (opts.agentFile) return readFile(opts.agentFile, "utf8")
  return defaultAgentManifest(opts.model ?? DEFAULT_MODEL)
}

/** Every AgentController built-in tool id — WP-1 disables them ALL so the
 *  controller adds nothing the raw-stream agent didn't have. Later WPs
 *  selectively re-enable (submit_plan for modes, subagent for spawning, …). */
export const DISABLED_BUILTIN_TOOL_IDS: readonly BuiltinToolId[] = [
  "ask_user",
  "submit_plan",
  "task_write",
  "task_update",
  "task_complete",
  "task_check",
  "subagent",
] as const

/** Session state the controller carries for us (see `initialState` below). */
interface AdapterControllerState {
  yolo?: boolean
}

/**
 * A lazy factory: parses the AGENT.md, builds the Mastra agent with the model
 * resolver, SQLite memory, the markdown body as instructions, and the
 * workspace toolset (matched by tool id), then wraps it in an
 * `AgentController` the ACP host creates sessions on.
 */
export function makeAgentFactory(
  opts: AgentSourceOptions = {},
): () => Promise<{ controller: AgentController<AdapterControllerState> }> {
  return async () => {
    const source = await resolveAgentSource(opts)
    const { frontmatter, body } = parseAgentManifest(source)
    const handle = agentFromManifest({ frontmatter, body })

    const cwd = opts.cwd ?? process.cwd()
    const workspaceTools = makeWorkspaceTools({
      cwd,
      allowExec: opts.allowExec,
      extraTools: opts.extraTools,
    })

    // One LibSQL store shared between the agent's Memory and the controller's
    // storage — two stores on one SQLite file would contend on writes.
    const store = buildSqliteStore()
    let memory: MastraMemoryLike | undefined

    const { agent } = await buildMastraAgent(handle, {
      resolveModel: (ref) => resolveMastraModel(ref),
      // Match each declared tool ref against the workspace toolset by id. A
      // ref with no matching executor still resolves — to a stub that fails
      // fast and clearly on call — rather than being dropped: a dropped ref
      // leaves the model unable to see it at all, and (if the model still
      // tries the name from AGENT.md prose) surfaces as an opaque provider
      // NoSuchToolError this adapter's ACP layer silently swallows (see
      // tool-call-map.ts), which is how a declared-but-unwired tool used to
      // hang a turn with zero recorded tool calls instead of failing fast.
      resolveTool: (ref) => {
        const id = toolRefId(ref)
        if (!id) return undefined
        const tool = workspaceTools[id]
        if (tool) return { name: id, tool }
        console.warn(
          `[@agentproto/adapter-mastra-agent] agent '${handle.id}' declares tool '${id}' but no ` +
            `executor is wired for it in this adapter's workspace toolset — calls to it will fail ` +
            `immediately instead of hanging. Wire it in workspace-tools.ts or pass it via extraTools.`,
        )
        return { name: id, tool: makeUnwiredToolStub(id) }
      },
      buildMemory: (config) => (memory = buildSqliteMemory(config, process.env, store)),
      // The markdown body is the agent's primary system prompt (AIP-42).
      body,
    })

    const config: AgentControllerConfig<AdapterControllerState> = {
      id: "agentproto-native",
      // The AGENT.md-built agent backs every mode; WP-1 has exactly one mode
      // and layers no mode instructions, so runs behave as the raw agent did.
      agent: agent as AgentControllerConfig["agent"],
      modes: [{ id: "main", metadata: { default: true } }],
      // Thread rows + per-thread settings persist to the same SQLite file the
      // agent's Memory writes messages to.
      storage: store,
      // Our hardened workspace toolset stays the tool surface. The backing
      // agent already carries the AGENT.md-declared subset; controller-level
      // tools are an additive toolset, so ids overlap onto the same executors.
      tools: workspaceTools as AgentControllerConfig["tools"],
      // WP-1 is behavior parity: no built-in controller tools, and no tool
      // approvals — `yolo: true` keeps `requireToolApproval` off so tools
      // execute pass-through exactly as the raw stream did (approvals are
      // WP-4; deliberately no `workspace` either, since a configured
      // Workspace makes the Agent inject Mastra's own workspace file tools
      // into every run).
      disableBuiltinTools: [...DISABLED_BUILTIN_TOOL_IDS],
      initialState: { yolo: true },
    }
    if (memory) config.memory = memory

    return { controller: new AgentController<AdapterControllerState>(config) }
  }
}
