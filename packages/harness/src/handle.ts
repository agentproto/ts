/**
 * @agentproto/harness — AgentHandle factory (WP2, STUB).
 *
 * `makeHandle` adapts a `HarnessClient` + a live session into the uniform
 * `AgentHandle` contract that every preset returns.
 */

import type { HarnessClient } from "./client.js"
import type { AgentHandle, TurnResult } from "./types.js"

export type { AgentHandle } from "./types.js"

export interface MakeHandleMeta {
  sessionId: string
  adapter: string
  model?: string
}

/**
 * Build an `AgentHandle` over a started session.
 *
 * WP2: implement `send` (→ client.prompt), `waitForTurn` (→ client.waitForAny
 * with `event: "turn-end"`, timeout → `{ event: "timeout" }`), `ask` (send +
 * waitForTurn + output), `output` (→ client.output), `kill` (→ client.kill).
 */
export function makeHandle(
  client: HarnessClient,
  meta: MakeHandleMeta,
): AgentHandle {
  return {
    sessionId: meta.sessionId,
    adapter: meta.adapter,
    model: meta.model,

    async send(prompt: string): Promise<void> {
      await client.prompt(meta.sessionId, prompt)
    },

    async waitForTurn(opts?: { timeoutMs?: number }): Promise<TurnResult> {
      return client.waitForAny([meta.sessionId], {
        event: "turn-end",
        ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      })
    },

    async ask(prompt: string, opts?: { timeoutMs?: number }): Promise<string> {
      await client.prompt(meta.sessionId, prompt)
      await client.waitForAny([meta.sessionId], {
        event: "turn-end",
        ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      })
      return client.output(meta.sessionId)
    },

    async output(opts?: { lastN?: number }): Promise<string> {
      return client.output(meta.sessionId, opts?.lastN)
    },

    async kill(): Promise<void> {
      await client.kill(meta.sessionId)
    },
  }
}
