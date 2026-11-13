/**
 * MCP tools over account slots (`accountSlots` in config.json, see
 * `account-slots.ts`): `account_slots_list` and `account_slots_swap`.
 *
 * `account_slots_swap` exchanges `<family>-primary` and `<family>-secondary`
 * (the "a subscription is exhausted" move). With `moveAlive`, it also restarts,
 * with their context, the ALIVE agent sessions billing the departing profile
 * (through the primary slot or by naming the profile literally) onto
 * `slot:<family>-primary`, which now points at the other account. Dead
 * sessions are never restarted. `dryRun` computes all of it and writes
 * nothing.
 *
 * The CLI (`agentproto accounts slots|swap`) is a thin wrapper over these two
 * tools, so both surfaces share one implementation.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { registerBuiltinTool } from "@agentproto/mcp-server"
import { catchErrors } from "@agentproto/tool"
import {
  applyAccountSlotSwap,
  listAccountSlotRows,
  loadAccountSlots,
  planAccountSlotSwap,
  sessionsToMoveOnSwap,
  slotRef,
  type AccountSlotRow,
  type AccountSlots,
  type AccountSlotSwapPlan,
  type ResolveProfileRefDeps,
} from "./account-slots.js"
import type { SessionDescriptor } from "./sessions.js"

export interface AccountSlotToolsDeps {
  registry: { list(opts?: { includeArchived?: boolean }): SessionDescriptor[] }
  /** Restart a session with its context onto a new access (the daemon wires
   *  `restartAgentSession` + cron re-arm). Absent: `moveAlive` is refused. */
  restartSession?: (
    prev: SessionDescriptor,
    overrides: { access: { profileRef: string } },
  ) => Promise<{ id: string; rearmedCrons?: string[] }>
  /** Slot map source. Defaults to config.json. */
  loadAccountSlots?: () => Promise<AccountSlots>
  /** Write a swap. Defaults to config.json. */
  applySwap?: (plan: AccountSlotSwapPlan) => Promise<void>
  getAuthProfile?: ResolveProfileRefDeps["getAuthProfile"]
}

export interface AccountSlotSwapResult {
  family: string
  dryRun: boolean
  before: { primary: string; secondary: string }
  after: { primary: string; secondary: string }
  /** Alive sessions selected for the move (`moveAlive`); on a dry run, the
   *  ones that WOULD move. */
  moved: Array<{ from: string; to?: string; label: string; rearmedCrons?: string[] }>
  failed: Array<{ id: string; label: string; error: string }>
}

/** The swap, testable without an MCP server. */
export async function runAccountSlotSwap(
  deps: AccountSlotToolsDeps,
  input: { family: string; moveAlive?: boolean; dryRun?: boolean },
): Promise<AccountSlotSwapResult> {
  const slots = await (deps.loadAccountSlots ?? (() => loadAccountSlots()))()
  const plan = planAccountSlotSwap(slots, input.family)
  if (input.moveAlive && !input.dryRun && !deps.restartSession) {
    throw new Error("account_slots_swap: moveAlive needs session restart, which this daemon does not wire.")
  }
  const toMove = input.moveAlive ? sessionsToMoveOnSwap(deps.registry.list(), plan) : []
  const result: AccountSlotSwapResult = {
    family: plan.family,
    dryRun: input.dryRun === true,
    before: { primary: plan.departing, secondary: plan.arriving },
    after: { primary: plan.arriving, secondary: plan.departing },
    moved: [],
    failed: [],
  }
  const labelOf = (s: SessionDescriptor) => s.name || s.label || s.id
  if (input.dryRun) {
    result.moved = toMove.map(s => ({ from: s.id, label: labelOf(s) }))
    return result
  }
  await (deps.applySwap ?? (p => applyAccountSlotSwap(p)))(plan)
  for (const s of toMove) {
    try {
      const next = await deps.restartSession!(s, { access: { profileRef: slotRef(plan.primarySlot) } })
      result.moved.push({
        from: s.id,
        to: next.id,
        label: labelOf(s),
        ...(next.rearmedCrons && next.rearmedCrons.length > 0 ? { rearmedCrons: next.rearmedCrons } : {}),
      })
    } catch (err) {
      result.failed.push({ id: s.id, label: labelOf(s), error: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}

export function registerAccountSlotTools(server: McpServer, deps: AccountSlotToolsDeps): void {
  const listSchema = z.object({})
  registerBuiltinTool<z.infer<typeof listSchema>, { slots: AccountSlotRow[] }>(server, {
    id: "account_slots_list",
    description:
      "List the account slots of config.json `accountSlots` (slot name -> real auth-profile id), whether " +
      "each target profile is usable (`problem`: missing / disabled), and the ALIVE sessions on each slot " +
      "(`via: slot` when the session asked for `slot:<name>`, `via: profile` when it names the profile " +
      "literally). A `profileRef` of `slot:<name>` resolves through this map at spawn, restart and " +
      "turnRetry fallback. No secret is returned.",
    inputSchema: listSchema,
    handler: async () => {
      const slots = await (deps.loadAccountSlots ?? (() => loadAccountSlots()))()
      return {
        slots: await listAccountSlotRows(slots, deps.registry.list(), {
          ...(deps.getAuthProfile ? { getAuthProfile: deps.getAuthProfile } : {}),
        }),
      }
    },
    transformers: [catchErrors()],
  })

  const swapSchema = z.object({
    family: z
      .string()
      .min(1)
      .describe("Slot family: swaps `<family>-primary` and `<family>-secondary` (e.g. `claude`)."),
    moveAlive: z
      .boolean()
      .optional()
      .describe(
        "Also restart (with context) the ALIVE sessions billing the departing primary profile, through " +
          "the primary slot or by naming it literally, onto `slot:<family>-primary`. Dead sessions are never touched.",
      ),
    dryRun: z.boolean().optional().describe("Compute the swap and the sessions that would move; write nothing."),
  })
  registerBuiltinTool<z.infer<typeof swapSchema>, AccountSlotSwapResult>(server, {
    id: "account_slots_swap",
    description:
      "Swap an account slot family in config.json `accountSlots`: `<family>-primary` and " +
      "`<family>-secondary` exchange their auth profiles, so every new spawn, restart and turnRetry " +
      "fallback naming `slot:<family>-primary` lands on the other account. `moveAlive` also restarts " +
      "(with context, new session id) the alive sessions on the departing account; dead sessions are " +
      "never restarted. `dryRun` reports without writing.",
    inputSchema: swapSchema,
    handler: input =>
      runAccountSlotSwap(deps, {
        family: input.family,
        ...(input.moveAlive !== undefined ? { moveAlive: input.moveAlive } : {}),
        ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      }),
    transformers: [catchErrors()],
  })
}
