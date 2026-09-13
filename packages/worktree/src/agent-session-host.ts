import {
  HarnessClient,
  resolveMcpUrl,
  type ConnectHarnessOptions,
  type SessionDescriptor,
  type SessionUsageSnapshot,
  type StartAgentArgs,
  type TurnEvent,
  type TurnResult,
} from "@agentproto/harness"
import type { AgentSessionHost } from "@agentproto/workflow-runtime"

/** `session_monitor`'s max accepted long-poll window (`orchestration-tools.ts`). */
const MAX_POLL_MS = 49_000

/** The subset of `HarnessClient` the host drives — narrowed for fake-client tests. */
export type DaemonClient = Pick<
  HarnessClient,
  "start" | "prompt" | "output" | "kill" | "waitForAny" | "currentEventsCursor" | "close"
> & {
  /** `session_usage` — optional so pre-existing fakes/clients without it still
   *  satisfy the type; the host simply exposes no `usage` then. */
  usage?: HarnessClient["usage"]
}

export interface DaemonAgentSessionHost extends AgentSessionHost {
  close(): Promise<void>
  /** Full `agent_start`, returning the raw descriptor and forwarding every
   *  `StartAgentArgs` field (`mcpServers`, `model`, `effort`, `label`, …) —
   *  unlike `spawn()` above (the narrow AgentStep-shaped convenience
   *  wrapper), which only takes `cwd`/`workspaceSlug`/`stepId`. Consumers
   *  that need finer per-turn control than the AgentStep contract provides
   *  (e.g. `@agentproto/sandbox`'s sandbox agent-session proxy) use this
   *  plus `prompt`/`output`/`kill`/`waitForAny` directly instead of
   *  `spawn`/`sendPromptAndWait`. */
  start(args: StartAgentArgs): Promise<SessionDescriptor>
  /** Send a follow-up turn — `opts.interrupt` cancels an in-flight turn and
   *  redirects the session onto this prompt (mirrors `agent_prompt`). */
  prompt(sessionId: string, prompt: string, opts?: { interrupt?: boolean }): Promise<void>
  /** Tail the ring buffer (`agent_output`). */
  output(sessionId: string, lastN?: number): Promise<string>
  /** SIGTERM the session (`agent_kill`). */
  kill(sessionId: string): Promise<void>
  /** Multiplexed long-poll (`session_monitor`) — see `HarnessClient.waitForAny`. */
  waitForAny(
    sessionIds: string[],
    opts?: { timeoutMs?: number; event?: TurnEvent; since?: number },
  ): Promise<TurnResult>
  /** Race-free cursor for a subsequent `waitForAny({ since })` — see
   *  `HarnessClient.currentEventsCursor`. */
  currentEventsCursor(): Promise<number>
  /** Usage accounting for a session on this daemon (`session_usage`) — present
   *  when the underlying client can answer it. `@agentproto/sandbox`'s host
   *  inherits it, which is how a sandboxed session's cost/tokens/model reach
   *  the HOST daemon's descriptor (the proxy's text stream carries none). */
  usage?(sessionId: string): Promise<SessionUsageSnapshot>
}

/**
 * Connect to the agentproto daemon's MCP endpoint and return a real,
 * supervisable `AgentSessionHost` — every `AgentStep` becomes an `agent_start`
 * daemon session rather than a bare subprocess. Fails loudly (no silent
 * fallback) if the daemon isn't reachable.
 */
export async function connectDaemonAgentSessionHost(
  opts?: ConnectHarnessOptions,
): Promise<DaemonAgentSessionHost> {
  const url = resolveMcpUrl(opts)
  let client: HarnessClient
  try {
    client = await HarnessClient.connect({ url })
  } catch (err) {
    throw new Error(
      `worktree-agent: could not reach the agentproto daemon's MCP endpoint at ${url}. ` +
        "Start the daemon (`agentproto daemon start`), or point at a running one via " +
        `AGENTPROTO_MCP_URL, before running this command.\n` +
        `(${err instanceof Error ? err.message : String(err)})`,
    )
  }
  return makeDaemonAgentSessionHost(client)
}

/** Build the host over an already-connected client (exported for tests with a fake client). */
export function makeDaemonAgentSessionHost(client: DaemonClient): DaemonAgentSessionHost {
  const sessionByStepId = new Map<string, string>()

  return {
    async spawn(adapter, opts): Promise<string> {
      const desc = await client.start({
        adapter,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.workspaceSlug !== undefined ? { workspaceSlug: opts.workspaceSlug } : {}),
        ...(opts.stepId !== undefined ? { label: opts.stepId } : {}),
      })
      if (opts.stepId) sessionByStepId.set(opts.stepId, desc.id)
      return desc.id
    },

    async sendPromptAndWait(sessionId, prompt): Promise<void> {
      // Capture a race-free cursor BEFORE sending: an extremely fast turn
      // can settle before a live bus subscription even starts — a real
      // race over the network round-trip to `prompt`/`waitForAny`, not
      // just in-process call ordering (see `HarnessClient
      // .currentEventsCursor`'s doc). The awaited cursor fetch completes
      // strictly before `prompt` is sent, so the daemon's ring-replay
      // branch can always find the matching turn-end regardless of how
      // late the long-poll's own subscription lands.
      const since = await client.currentEventsCursor()
      await client.prompt(sessionId, prompt)
      await waitForSettled(client, sessionId, since)
    },

    resolveByLabel(stepId): string | undefined {
      return sessionByStepId.get(stepId)
    },

    async start(args): Promise<SessionDescriptor> {
      return client.start(args)
    },

    async prompt(sessionId, prompt, opts): Promise<void> {
      await client.prompt(sessionId, prompt, opts)
    },

    async output(sessionId, lastN): Promise<string> {
      return client.output(sessionId, lastN)
    },

    async kill(sessionId): Promise<void> {
      await client.kill(sessionId)
    },

    async waitForAny(sessionIds, opts): Promise<TurnResult> {
      return client.waitForAny(sessionIds, opts)
    },

    async currentEventsCursor(): Promise<number> {
      return client.currentEventsCursor()
    },

    ...(typeof client.usage === "function"
      ? {
          async usage(sessionId: string): Promise<SessionUsageSnapshot> {
            return client.usage!(sessionId)
          },
        }
      : {}),

    async close(): Promise<void> {
      await client.close()
    },
  }
}

/**
 * `session_monitor` long-polls cap at 49s; loop past timeouts for longer
 * turns. A clean timeout comes back as `{ timedOut: true, sessionIds }` —
 * there is no `event: "timeout"` on the wire, `event` is only ever set on a
 * real match. Keep polling while `timedOut` is true; stop once it's
 * falsy/absent (a real turn-end/awaiting-input/exited match). `since` is
 * reused unchanged across retries — a timeout means nothing has matched
 * since that cursor yet, so there is nothing to advance.
 */
async function waitForSettled(client: DaemonClient, sessionId: string, since: number): Promise<void> {
  for (;;) {
    const result = await client.waitForAny([sessionId], { event: "any", timeoutMs: MAX_POLL_MS, since })
    if (!result.timedOut) return
  }
}
