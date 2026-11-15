/**
 * MCP tools over account health (`account-health.ts`):
 *
 *  - `account_health_list`: every account the daemon knows about (the ones with
 *    a health entry, plus every account listed in `accountSlots`): state
 *    (`ok` / `exhausted` / `probing`), `until`, where `until` came from
 *    (`untilBasis`), the reason, strikes, and for an Anthropic profile the
 *    last remaining-quota figures a reader stored (no live probe, so nothing
 *    is billed).
 *  - `account_health_clear`: forget an account's entry, for the day it is
 *    topped up before its `until`.
 *
 * The CLI (`agentproto accounts health [--clear <profile>]`) is a thin wrapper
 * over these two tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { registerBuiltinTool } from "@agentproto/mcp-server"
import { catchErrors } from "@agentproto/tool"
import { getAuthProfile as defaultGetAuthProfile } from "@agentproto/auth"
import {
  createAccountHealthStore,
  type AccountHealthStore,
  type AccountHealthView,
} from "./account-health.js"
import { loadAccountSlots, slotMembers, type AccountSlots } from "./account-slots.js"
import { readProfileQuota, type StoredProfileQuota } from "./remaining-quota-store.js"

export interface AccountHealthToolsDeps {
  /** Health source. Defaults to `~/.agentproto/account-health.json`. */
  store?: AccountHealthStore
  /** Slot map source. Defaults to config.json's `accountSlots`. */
  loadAccountSlots?: () => Promise<AccountSlots>
  /** Profile lookup, to read an account's endpoint. Defaults to the auth store. */
  getAuthProfile?: (id: string) => Promise<{ endpoint: string } | undefined>
  /** Last stored remaining quota of a profile. Defaults to the usage-quota store. */
  readQuota?: (profileRef: string) => Promise<StoredProfileQuota | undefined>
}

export interface AccountHealthRow {
  profileRef: string
  state: "ok" | "exhausted" | "probing"
  until?: string
  untilBasis?: AccountHealthView["untilBasis"]
  reason?: string
  since?: string
  strikes?: number
  /** Slots whose slot lists this account. */
  slots?: string[]
  /** Anthropic profiles: the last remaining-quota figures a reader stored. */
  quota?: { fetchedAt: string; windows: StoredProfileQuota["windows"] }
}

/** The list, testable without an MCP server. */
export async function listAccountHealthRows(deps: AccountHealthToolsDeps = {}): Promise<AccountHealthRow[]> {
  const store = deps.store ?? createAccountHealthStore()
  const slots = await (deps.loadAccountSlots ?? (() => loadAccountSlots()))().catch(() => ({}) as AccountSlots)
  const getProfile = deps.getAuthProfile ?? defaultGetAuthProfile
  const readQuota = deps.readQuota ?? ((ref: string) => readProfileQuota(ref))

  const views = new Map((await store.list()).map(v => [v.profileRef, v]))
  const slotsOf = new Map<string, string[]>()
  for (const [slot, target] of Object.entries(slots)) {
    for (const member of slotMembers(target)) slotsOf.set(member, [...(slotsOf.get(member) ?? []), slot])
  }
  const refs = [...new Set([...views.keys(), ...slotsOf.keys()])]
  const rows: AccountHealthRow[] = []
  for (const profileRef of refs) {
    const view = views.get(profileRef)
    const profile = await getProfile(profileRef).catch(() => undefined)
    const stored = profile?.endpoint === "anthropic" ? await readQuota(profileRef).catch(() => undefined) : undefined
    rows.push({
      profileRef,
      state: view ? view.state : "ok",
      ...(view
        ? { until: view.until, untilBasis: view.untilBasis, reason: view.reason, since: view.since, strikes: view.strikes }
        : {}),
      ...(slotsOf.has(profileRef) ? { slots: slotsOf.get(profileRef)! } : {}),
      ...(stored ? { quota: { fetchedAt: stored.fetchedAt, windows: stored.windows } } : {}),
    })
  }
  const rank = { exhausted: 0, probing: 1, ok: 2 } as const
  return rows.sort(
    (a, b) =>
      rank[a.state] - rank[b.state] ||
      (a.until ?? "").localeCompare(b.until ?? "") ||
      a.profileRef.localeCompare(b.profileRef),
  )
}

/** The summary `daemon_health` carries: closed accounts and when they return. */
export async function summarizeAccountHealth(
  store: AccountHealthStore = createAccountHealthStore(),
): Promise<Array<{ profileRef: string; until: string; untilBasis: string; reason: string }>> {
  const views = await store.list().catch(() => [] as AccountHealthView[])
  return views
    .filter(v => v.state === "exhausted")
    .map(v => ({ profileRef: v.profileRef, until: v.until, untilBasis: v.untilBasis, reason: v.reason }))
}

export function registerAccountHealthTools(server: McpServer, deps: AccountHealthToolsDeps = {}): void {
  const listSchema = z.object({})
  registerBuiltinTool<z.infer<typeof listSchema>, { accounts: AccountHealthRow[] }>(server, {
    id: "account_health_list",
    description:
      "List every account the daemon knows: those with a health entry plus every account listed in " +
      "`accountSlots`. `state`: `ok`, `exhausted` (closed until `until`: nothing is started on it, a slot " +
      "skips it) or `probing` (`until` has passed: eligible again, the next real turn is the trial). " +
      "`untilBasis` (AIP-67 `basis` vocabulary): `provider` or `probe` (a quota reader's resetsAt), " +
      "`observed` (the provider's own message said when) or `estimated` (a 30 min, 2 h, 6 h, then 24 h " +
      "backoff by strike). An Anthropic profile also carries the last " +
      "remaining quota a reader stored (no live probe is made). Clear an entry with account_health_clear.",
    inputSchema: listSchema,
    handler: async () => ({ accounts: await listAccountHealthRows(deps) }),
    transformers: [catchErrors()],
  })

  const clearSchema = z.object({
    profileRef: z.string().min(1).describe("The real auth-profile id to reopen (not a `slot:` ref)."),
  })
  registerBuiltinTool<z.infer<typeof clearSchema>, { profileRef: string; cleared: boolean }>(server, {
    id: "account_health_clear",
    description:
      "Reopen an account now: forget its health entry (exhausted or probing). Use it when the account was " +
      "topped up before its `until`. Returns whether there was an entry. A `slot:` ref is refused: health is " +
      "kept per real profile.",
    inputSchema: clearSchema,
    handler: async input => {
      if (input.profileRef.startsWith("slot:")) {
        throw new Error("account_health_clear: name a real auth profile, not a slot (see account_health_list).")
      }
      const store = deps.store ?? createAccountHealthStore()
      return { profileRef: input.profileRef, cleared: await store.clear(input.profileRef) }
    },
    transformers: [catchErrors()],
  })
}
