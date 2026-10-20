/**
 * The lineage-handover MCP verbs - the explicit half of the generic
 * succession mechanism (see `lineage-handover.ts`).
 *
 * `session_adopt { childIds, from }` re-parents the named children of
 * `from` onto `from`'s DECLARED successor (the row that took over `from`'s
 * position - recorded as `from.succeededBy`). Authorized to the human
 * operator and to that declared successor; nobody else.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"
import { effectiveCallerSessionId, promptCallerLabel } from "./session-owner.js"
import { checkAdoptAuthority, handoverLineage } from "./lineage-handover.js"

export interface RegisterLineageToolsOptions {
  registry: SessionsRegistry
  /** The scoped orchestrator gateway's verified scope, when the call came
   *  through one. */
  callerScope?: { ownerSessionId?: string }
  /** The trusted `?callerSessionId=` identity, when the call carried one. */
  callerSessionId?: string
}

/** Resolve a session by id (exact match only - no fuzzy lookup: an adopt
 *  must name the row explicitly). */
function findById(registry: SessionsRegistry, id: string): SessionDescriptor | undefined {
  return registry.get(id)
}

export function registerLineageTools(server: McpServer, opts: RegisterLineageToolsOptions): void {
  const { registry } = opts
  const effectiveCaller = (): string | undefined =>
    effectiveCallerSessionId(opts.callerScope, opts.callerSessionId)

  server.tool(
    "session_adopt",
    "Lineage handover: adopt the named CHILDREN of a replaced session onto its " +
      "DECLARED successor - the session recorded as that row's successor (the one " +
      "that took over its place in the spawn tree, e.g. after a continue-fresh or an " +
      "`agent_start.succeeds` declaration). The adopted children's `parentSessionId` " +
      "moves, so the successor can DRIVE them (agent_prompt / agent_interrupt / " +
      "session_restart) and their `message_parent` reports reach the successor instead " +
      "of the dead row they were spawned under. Only the human operator or that " +
      "declared successor may run this.",
    {
      from: z
        .string()
        .min(1)
        .describe("The session whose children are being adopted (the replaced row)."),
      childIds: z
        .array(z.string().min(1))
        .min(1)
        .describe("Ids of the children to move onto the successor."),
    },
    async input => {
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true,
      })
      const from = findById(registry, input.from)
      if (!from) {
        return fail(`session_adopt: no session "${input.from}" found.`)
      }
      const successorId = from.succeededBy
      if (!successorId) {
        return fail(
          `session_adopt: session "${from.id}" has no DECLARED successor - nothing to adopt ` +
            "onto. Declare the succession first (agent_start { succeeds: \"" +
            from.id +
            "\" } by the operator or by the replaced session itself, or a " +
            "session_continue_fresh of that session).",
        )
      }
      const successor = findById(registry, successorId)
      if (!successor) {
        return fail(
          `session_adopt: the declared successor "${successorId}" of "${from.id}" no longer exists.`,
        )
      }
      if (successor.id === from.id) {
        return fail(`session_adopt: "${from.id}" cannot adopt onto itself.`)
      }
      const caller = effectiveCaller()
      const gate = checkAdoptAuthority({
        callerSessionId: caller,
        from,
        successorId,
      })
      if (!gate.ok) {
        return fail(`session_adopt: ${gate.message}`)
      }
      const outcome = handoverLineage({
        registry,
        from: from.id,
        to: successor.id,
        childIds: input.childIds,
        reason: "session_adopt",
        actor: promptCallerLabel(caller),
      })
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                from: outcome.from,
                to: outcome.to,
                adopted: outcome.adopted,
                skipped: outcome.skipped,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )
}
