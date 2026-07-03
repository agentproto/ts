/**
 * @agentproto/adapter-hermes — AIP-45 adapter for Nous Research's Hermes Agent.
 *
 * Re-exports a `defineAgentCli` instance plus the runtime factory so
 * a host can boot Hermes with one import:
 *
 *   import { hermes, hermesRuntime } from "@agentproto/adapter-hermes"
 *   const session = await hermesRuntime().start({ env: { OPENROUTER_API_KEY } })
 *   for await (const evt of session.send({ role: "user", content: "..." })) {
 *     console.log(evt)
 *   }
 *   await session.close()
 *
 * The companion HERMES.md / SECRETS.md / hermes-acp.ACP.md files in
 * this package describe the manifest, secret slots, and ACP wire
 * profile.
 */

import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"

export const hermes: AgentCliHandle = defineAgentCli({
  name: "hermes",
  id: "hermes",
  description:
    "Nous Research's Hermes Agent — autonomous CLI agent with skills, sandboxes, memory plugins, and a built-in ACP server. Spawned as `hermes acp` and driven over stdio JSON-RPC.",
  version: "0.1.0",
  bin: "hermes",
  bin_args: ["acp"],
  install: [
    {
      method: "curl",
      url: "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh",
    },
  ],
  version_check: {
    cmd: "hermes --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.13.0 <1.0.0",
    timeout_ms: 5000,
  },
  auth: {
    ref: "./SECRETS.md",
    state: { env: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] },
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./hermes-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
    // hermes's own ACP server has been observed to hit its internal
    // max-tool-iterations cap, produce a final answer, and then never
    // send the `prompt` JSON-RPC response — hanging the daemon's turn
    // drain loop forever with no other adapter-side signal available.
    // 5 minutes of true silence (reset on any ACP traffic, so a long
    // legitimate tool-call chain doesn't false-positive) is generous
    // enough to not trip during normal use.
    turn_idle_timeout_ms: 300_000,
  },
  models: {
    // Cheap OpenRouter models by default — hermes is the budget delegation
    // arm (a Sonnet default would defeat the purpose). glm-5.2 + deepseek
    // are the go-to cheap coders; the bigger models stay available.
    default: "z-ai/glm-5.2",
    allowed: [
      "z-ai/glm-5.2",
      "deepseek/deepseek-v4-pro",
      "meta-llama/llama-3.3-70b",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-7",
      "openai/gpt-4",
    ],
    env: {
      anthropic: "ANTHROPIC_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      openai: "OPENAI_API_KEY",
    },
    // hermes keeps its own configured default when given a model via the
    // ACP session config — selection must go through a `/model <id>`
    // control turn instead. See AgentCliModels.apply.
    apply: "command",
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    sub_agents: true,
    file_io: true,
    multimodal: true,
    resumable: false,
    bidirectional: true,
  },
  modes: [
    {
      id: "default",
      description:
        "Standard interactive mode — loads ~/.hermes/config.yaml and auto-injects " +
        "rules/memory/preloaded skills as usual.",
    },
    {
      id: "lean",
      description:
        "Skip ~/.hermes/config.yaml, cutting the skills/rules/memory scaffolding hermes " +
        "would otherwise preload into context. Composed as `hermes --ignore-user-config " +
        "acp` — the global flag MUST precede the `acp` subcommand baked into `bin_args`, " +
        "which is why this needs bin_args_prepend rather than bin_args_append.",
      bin_args_prepend: ["--ignore-user-config"],
      status: "noop",
      status_note:
        "Measured no-op: --ignore-user-config skips ~/.hermes/config.yaml, but hermes " +
        "skills live in a separate skills dir (not config), so prompt-size is " +
        "byte-identical. The real lean lever is narrowing the mounted toolset, not " +
        "this flag.",
    },
  ],
  options: [
    {
      id: "skills",
      type: "string" as const,
      description:
        "Preload one or more agentskills.io-compatible skills for the session " +
        "(comma-separate for multiple), via hermes' `--skills` global flag. Same " +
        "prepend-before-`acp` constraint as the `lean` mode.",
      bin_args_prepend: ["--skills", "{value}"],
    },
    {
      id: "model",
      // string (not enum) so any valid OpenRouter/Anthropic/OpenAI model ID is
      // accepted without requiring a code change to expand the list. Applied via
      // ACP newSession(model:...) — hermes reads the model from the ACP session
      // config, not from its own CLI args.
      type: "string" as const,
      description:
        "Model ID routed through OpenRouter/Anthropic/OpenAI " +
        "(e.g. 'anthropic/claude-sonnet-4-6', 'deepseek/deepseek-v4-pro', 'z-ai/glm-5.2'). " +
        "Applied via a `/model <id>` control turn after the session is created " +
        "(hermes ignores the ACP session model config). " +
        "Omit to use the hermes default.",
    },
    {
      id: "effort",
      type: "enum" as const,
      enum: ["low", "medium", "high", "xhigh", "max"],
      description:
        "Reasoning effort level passed to hermes via ACP newSession. " +
        "Omit to use the hermes default.",
    },
  ],
  tags: ["hermes", "nous", "acp", "agent-runtime"],
})

export function hermesRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(hermes)
}

import { homedir } from "node:os"
import { join } from "node:path"

/** Best-effort read of a hermes session's cost/token usage from its state.db.
 *
 *  hermes writes the per-turn cost to state.db slightly AFTER the ACP turn
 *  ends, so a single read right at turn-end usually finds the cost column
 *  still null. We poll a few times with a short backoff until the cost lands
 *  (or give up — best-effort, never throws). Bounded so a missing write can't
 *  hang the caller (the turn-end path awaits this). */
export async function readHermesUsage(
  sessionId: string,
): Promise<{ costUsd?: number; tokensIn?: number; tokensOut?: number } | null> {
  try {
    // node:sqlite is a Node 22+ builtin. Build the specifier at runtime so the
    // bundler (esbuild/tsup) can't statically rewrite it — it strips the
    // `node:` prefix off this not-yet-recognised builtin, turning the import
    // into a missing `sqlite` package that throws and silently yields null.
    const sqliteSpecifier = ["node", "sqlite"].join(":")
    const { DatabaseSync } = (await import(sqliteSpecifier)) as unknown as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => {
        prepare(sql: string): { get(...a: unknown[]): unknown }
        close(): void
      }
    }
    const dbPath = join(homedir(), ".hermes", "state.db")
    const ATTEMPTS = 6
    const DELAY_MS = 130
    let last: { costUsd?: number; tokensIn?: number; tokensOut?: number } | null = null
    for (let i = 0; i < ATTEMPTS; i++) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const row = db.prepare(
        "select estimated_cost_usd as cost, input_tokens as ti, output_tokens as to_ from sessions where id = ?",
      ).get(sessionId) as { cost?: number; ti?: number; to_?: number } | undefined
      db.close()
      if (row) {
        last = { costUsd: row.cost, tokensIn: row.ti, tokensOut: row.to_ }
        // Cost has landed (non-null) → done. Otherwise keep polling: the row
        // exists but hermes hasn't written the cost for this turn yet.
        if (row.cost !== null && row.cost !== undefined) return last
      }
      if (i < ATTEMPTS - 1) await new Promise(r => setTimeout(r, DELAY_MS))
    }
    return last
  } catch {
    return null
  }
}

export type { AgentCliHandle, AgentCliRuntime }
