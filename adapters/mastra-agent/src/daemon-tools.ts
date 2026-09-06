/**
 * Daemon sub-agent-spawning tools — the Mastra-tool front for
 * {@link DaemonClient}. Lets the agent spawn/prompt/read/list sibling
 * sessions through the agentproto daemon (any adapter: claude-code, hermes,
 * another mastra-agent, ...), mirroring `workspace-tools.ts`'s style
 * (`createTool`, zod schemas, a bounded `tail` on large text output, a
 * per-call timeout guard).
 *
 * Every tool fails fast with a clear message when no daemon is discoverable
 * ({@link DaemonNotFoundError}'s message) instead of hanging — `DaemonClient`
 * throws that before any network call is attempted.
 */

import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { DaemonClient, type DaemonClientOptions } from "./daemon-client.js"
import { withTimeoutGuard } from "./workspace-tools.js"

/** Keep large daemon-returned text bounded — same policy as workspace-tools. */
function tail(s: string, maxChars = 4000): string {
  return s.length > maxChars ? s.slice(-maxChars) : s
}

export interface DaemonToolsOptions {
  /** Reuse a pre-built client (mainly a test hook) — one is built otherwise. */
  client?: DaemonClient
  /** Forwarded to `new DaemonClient(...)` when no `client` is supplied. */
  clientOptions?: DaemonClientOptions
  /** Per-tool execution timeout (ms). Default 30_000 — network calls, not
   *  local fs/exec, so a shorter default than workspace-tools' 120_000. */
  execTimeoutMs?: number
}

/**
 * Build the daemon sub-agent-spawning toolset: `agent_start`, `agent_prompt`,
 * `agent_output`, `session_list`. Tool ids match `tool-categories.ts`'s
 * `CATEGORY_BY_TOOL` entries exactly (all category `mcp`, default policy
 * `ask`).
 */
export function makeDaemonTools(
  opts: DaemonToolsOptions = {},
): Record<string, ReturnType<typeof createTool>> {
  const client = opts.client ?? new DaemonClient(opts.clientOptions)
  const execTimeoutMs = opts.execTimeoutMs ?? 30_000
  const guard = <Input, Output>(id: string, execute: (input: Input) => Promise<Output>) =>
    withTimeoutGuard(id, execTimeoutMs, execute)

  const agent_start = createTool({
    id: "agent_start",
    description:
      "Spawn a new agent session via the agentproto daemon (any adapter: claude-code, hermes, " +
      "mastra-agent, ...). The spawned session's lineage is recorded as a child of this session " +
      "when running under a daemon-spawned session. Returns the daemon's session descriptor " +
      "(includes the new session's id — pass it to `agent_prompt` / `agent_output`).",
    inputSchema: z.object({
      adapter: z.string().describe("Adapter id to spawn, e.g. 'claude-code', 'hermes', 'mastra-agent'."),
      cwd: z.string().optional().describe("Working directory for the spawned session. Defaults to the daemon's workspace resolution."),
      model: z.string().optional().describe("Model id to spawn the session with, if the adapter supports selecting one."),
      prompt: z.string().optional().describe("Initial prompt to send once the session is up."),
      label: z.string().optional().describe("Human-readable label for the spawned session."),
    }),
    outputSchema: z.record(z.string(), z.unknown()),
    execute: guard("agent_start", async (input: { adapter: string; cwd?: string; model?: string; prompt?: string; label?: string }) =>
      client.startAgent(input),
    ),
  })

  const agent_prompt = createTool({
    id: "agent_prompt",
    description:
      "Send a follow-up message to a live session spawned via `agent_start` (or any other daemon " +
      "session id). Blocks until the turn drains by default; set `wait: false` to return as soon as " +
      "the prompt is queued.",
    inputSchema: z.object({
      sessionId: z.string().describe("Target session id (from `agent_start`'s result or `session_list`)."),
      text: z.string().describe("The message to send."),
      interrupt: z.boolean().optional().describe("Cancel the target session's in-flight turn and deliver this prompt instead. Default false."),
      wait: z.boolean().optional().describe("Wait for the turn to drain before returning. Default true."),
    }),
    outputSchema: z.record(z.string(), z.unknown()),
    execute: guard(
      "agent_prompt",
      async (input: { sessionId: string; text: string; interrupt?: boolean; wait?: boolean }) =>
        client.promptAgent(input.sessionId, input.text, {
          ...(input.interrupt !== undefined ? { interrupt: input.interrupt } : {}),
          ...(input.wait !== undefined ? { wait: input.wait } : {}),
        }),
    ),
  })

  const agent_output = createTool({
    id: "agent_output",
    description:
      "Read a session's transcript (works for any agent-cli session, not just ones this agent " +
      "spawned). Output is tailed to the most recent text when it's large.",
    inputSchema: z.object({
      sessionId: z.string().describe("Session id to read."),
      format: z.enum(["markdown", "json"]).optional().describe("Transcript rendering. Default 'json'."),
    }),
    outputSchema: z.object({
      adapter: z.string().optional(),
      content: z.string().optional(),
    }).catchall(z.unknown()),
    execute: guard("agent_output", async (input: { sessionId: string; format?: "markdown" | "json" }) => {
      const result = await client.readOutput(input.sessionId, {
        ...(input.format ? { format: input.format } : {}),
      })
      return typeof result.content === "string" ? { ...result, content: tail(result.content) } : result
    }),
  })

  const session_list = createTool({
    id: "session_list",
    description: "List sessions known to the daemon — spawned by this agent or any other client.",
    inputSchema: z.object({
      includeArchived: z.boolean().optional().describe("Include archived sessions. Default false."),
      kind: z.string().optional().describe("Filter by session kind (e.g. 'agent-cli', 'command', 'all')."),
    }),
    outputSchema: z.object({ sessions: z.array(z.record(z.string(), z.unknown())) }),
    execute: guard("session_list", async (input: { includeArchived?: boolean; kind?: string }) =>
      client.listSessions(input),
    ),
  })

  return { agent_start, agent_prompt, agent_output, session_list }
}
