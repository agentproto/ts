/**
 * The caller context of a session whose driver is starting but whose
 * descriptor is not registered yet.
 *
 * A local spawn registers its descriptor only once `startSession` resolves,
 * and an ACP adapter connects its MCP servers inside `session/new`: Claude
 * Code lists the `/mcp` gateway's tools during that call. The gateway then
 * finds no descriptor for the stamped `callerSessionId`, so it serves the
 * caller as anonymous and the agent's `requires.apps` grants, its AGENT.md
 * opt-in and its deny grants are all missing from the one `tools/list` the
 * client keeps (agentproto/ts#2661). The spawn stages here the same fields it
 * is about to record on the descriptor; the gateway reads them only when the
 * registry has no row for the id.
 */

import type { Grant } from "@agentproto/policy"

/** The descriptor fields the gateway reads for a caller. */
export interface SpawningCallerContext {
  readonly meta?: Readonly<Record<string, string>> | undefined
  readonly exposedToolOptIn?: readonly string[] | undefined
  readonly toolDenyGrants?: readonly Grant[] | undefined
}

const staged = new Map<string, SpawningCallerContext>()

/** Stage `ctx` for `sessionId` until the returned function is called. */
export function stageSpawningCaller(sessionId: string, ctx: SpawningCallerContext): () => void {
  staged.set(sessionId, ctx)
  return () => {
    if (staged.get(sessionId) === ctx) staged.delete(sessionId)
  }
}

/** The staged context of a session still starting, else undefined. */
export function spawningCallerContext(sessionId: string): SpawningCallerContext | undefined {
  return staged.get(sessionId)
}
