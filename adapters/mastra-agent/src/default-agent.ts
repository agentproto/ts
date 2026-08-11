/**
 * Builds a runnable Mastra agent from an AIP-42 AGENT.md — either a caller's
 * file or a zero-config built-in default — wiring the model, the markdown body
 * as instructions, the SQLite memory, and the workspace toolset.
 */

import { readFile } from "node:fs/promises"
import { agentFromManifest, parseAgentManifest } from "@agentproto/agent"
import { buildMastraAgent } from "@agentproto/mastra"
import type { MastraToolLike } from "@agentproto/mastra"
import type { MastraLike } from "./acp-host.js"
import { buildSqliteMemory } from "./memory.js"
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

/**
 * A lazy factory: parses the AGENT.md, builds the Mastra agent with the model
 * resolver, SQLite memory, the markdown body as instructions, and the
 * workspace toolset (matched by tool id), then returns it as the structural
 * `MastraLike` the ACP host needs.
 */
export function makeAgentFactory(
  opts: AgentSourceOptions = {},
): () => Promise<MastraLike> {
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
      buildMemory: (config) => buildSqliteMemory(config),
      // The markdown body is the agent's primary system prompt (AIP-42).
      body,
    })
    return agent as unknown as MastraLike
  }
}
