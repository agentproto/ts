import { HarnessClient, resolveMcpUrl, type ConnectHarnessOptions } from "@agentproto/harness"
import type { AgentSessionHost } from "@agentproto/workflow-runtime"

/** `session_monitor`'s max accepted long-poll window (`orchestration-tools.ts`). */
const MAX_POLL_MS = 49_000

/** The subset of `HarnessClient` the host drives — narrowed for fake-client tests. */
export type DaemonClient = Pick<HarnessClient, "start" | "prompt" | "waitForAny" | "close">

export interface DaemonAgentSessionHost extends AgentSessionHost {
  close(): Promise<void>
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
      // Subscribe before sending: an extremely fast turn could otherwise settle
      // before the wait call subscribes (same race `harness`'s `ask()` avoids).
      const waitPromise = waitForSettled(client, sessionId)
      await client.prompt(sessionId, prompt)
      await waitPromise
    },

    resolveByLabel(stepId): string | undefined {
      return sessionByStepId.get(stepId)
    },

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
 * falsy/absent (a real turn-end/awaiting-input/exited match).
 */
async function waitForSettled(client: DaemonClient, sessionId: string): Promise<void> {
  for (;;) {
    const result = await client.waitForAny([sessionId], { event: "any", timeoutMs: MAX_POLL_MS })
    if (!result.timedOut) return
  }
}
