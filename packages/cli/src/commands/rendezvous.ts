/**
 * `agentproto rendezvous serve [--port] [--host]` — a thin re-export of the
 * `@agentproto/rendezvous` CLI, so users can self-host the untrusted broker
 * without putting the `agentproto-rendezvous` bin on their PATH.
 */

import { runRendezvousCli } from "@agentproto/rendezvous/cli"

export async function runRendezvous(args: readonly string[]): Promise<number> {
  return runRendezvousCli(args)
}
