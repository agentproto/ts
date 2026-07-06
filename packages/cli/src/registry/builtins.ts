/**
 * Built-in MultiAgentRuntime adapters. Registers reference adapters
 * shipped by `@agentproto/agent-runtime` against the runtime registry
 * so a vanilla `agentproto run-swarm` works without any plugins.
 *
 * Built-in `kind` strings: `file`, `mention`, `fs`, `agent-cli`.
 */

import { resolve as resolvePath } from "node:path"
import { FileSubstrate } from "@agentproto/agent-runtime/adapters/substrate-file"
import { MentionDispatcher } from "@agentproto/agent-runtime/adapters/dispatcher-mention"
import { FileStateStore } from "@agentproto/agent-runtime/adapters/state-fs"
import {
  AgentCliParticipant,
  parseClaudeJsonOutput,
} from "@agentproto/agent-runtime/adapters/participant-agent-cli"
import {
  registerDispatcher,
  registerExecutor,
  registerStateStore,
  registerSubstrate,
  type AdapterConfig,
  type AdapterContext,
} from "./runtime.js"

export function registerBuiltins(): void {
  registerSubstrate("file", (cfg, ctx) => {
    const path = typeof cfg.path === "string" ? cfg.path : ".runtime/conversation.md"
    return new FileSubstrate({ path: resolvePath(ctx.baseDir, path) })
  })

  registerDispatcher("mention", () => new MentionDispatcher())

  registerStateStore("fs", (cfg, ctx) => {
    const dir = typeof cfg.dir === "string" ? cfg.dir : ".runtime/state"
    return new FileStateStore({ dir: resolvePath(ctx.baseDir, dir) })
  })

  registerExecutor("agent-cli", (cfg, ctx) => buildAgentCli(cfg, ctx))
}

function buildAgentCli(cfg: AdapterConfig, ctx: AdapterContext): AgentCliParticipant {
  const command = typeof cfg.command === "string" ? cfg.command : "claude"
  const defaultArgs =
    command === "claude"
      ? ["--print", "--output-format=json", "--permission-mode", "bypassPermissions"]
      : ["--print", "--output-format=json"]
  const args = Array.isArray(cfg.args)
    ? cfg.args.filter((a): a is string => typeof a === "string")
    : defaultArgs
  const useClaudeJson = cfg.parseJson !== false && command === "claude"
  const model = typeof cfg.model === "string" ? cfg.model : undefined
  const finalArgs =
    model && command === "claude" && !hasModelFlag(args)
      ? [...args, "--model", model]
      : args
  return new AgentCliParticipant({
    command,
    args: finalArgs,
    parseOutput: useClaudeJson ? parseClaudeJsonOutput : undefined,
    baseDir: ctx.baseDir,
  })
}

function hasModelFlag(args: readonly string[]): boolean {
  return args.some((a) => a === "--model" || a.startsWith("--model="))
}

// Suppress unused-context warning on registrations that don't read it.
export type { AdapterContext }
