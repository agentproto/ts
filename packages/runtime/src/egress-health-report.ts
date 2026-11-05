/**
 * `sandbox egress-health` - the read side of the egress IP health ledger, plus
 * the on-demand re-probe. The read lists the provider's pool slots, their
 * public addresses and the active cooldowns; the probe boots one box per slot,
 * runs the `model-answers` preflight from that address, and clears or sets the
 * cooldown from the verdict. There is deliberately no scheduler: a probe boots
 * real boxes, so it runs when an operator (or a placement ladder) asks.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SandboxEgressSlot, SandboxSpec } from "@agentproto/sandbox"
import { makeSandboxCredsStore, makeSandboxResolver, type SandboxProviderResolver } from "./sandbox-adapters.js"
import {
  egressHealthLedger,
  isEgressHealthErrorClass,
  type EgressCooldownEntry,
  type EgressHealthLedger,
} from "./egress-health.js"
import { MODEL_ANSWERS_PROBE_ID, defaultPreflightRegistry, runSandboxPreflight, type PreflightRegistry } from "./sandbox-preflight.js"

export const DEFAULT_EGRESS_HEALTH_PROVIDER = "computer"

export interface EgressHealthSlotView {
  slot: string
  publicIp: string
  /** Boxes currently using the slot, when the provider reports it. */
  computers?: number
  /** Active cooldowns on this slot's address, soonest-to-expire first. */
  cooling: EgressCooldownEntry[]
}

export type EgressHealthReport =
  | {
      ok: true
      provider: string
      /** Set when the read was narrowed to one model. */
      model?: string
      slots: EgressHealthSlotView[]
      /** Every active cooldown, including addresses no longer in the pool. */
      cooldowns: EgressCooldownEntry[]
    }
  | { ok: false; code: "egress_provider_not_found" | "egress_pool_unsupported" | "egress_pool_failed"; message: string }

export interface EgressHealthDeps {
  resolveSandboxProvider?: SandboxProviderResolver
  ledger?: EgressHealthLedger
}

async function readPool(
  provider: string,
  deps: EgressHealthDeps,
): Promise<
  | { ok: true; slots: SandboxEgressSlot[] }
  | Extract<EgressHealthReport, { ok: false }>
> {
  const resolver = deps.resolveSandboxProvider ?? makeSandboxResolver(makeSandboxCredsStore())
  const handle = await resolver(provider)
  if (!handle) {
    return {
      ok: false,
      code: "egress_provider_not_found",
      message: `sandbox egress-health: sandbox provider "${provider}" not found (see list_sandbox_providers)`,
    }
  }
  if (!handle.provider.egressPool) {
    return {
      ok: false,
      code: "egress_pool_unsupported",
      message: `sandbox egress-health: provider "${provider}" has no egress address pool`,
    }
  }
  try {
    const spec: SandboxSpec = { provider, config: {} }
    return { ok: true, slots: await handle.provider.egressPool(spec) }
  } catch (err) {
    return {
      ok: false,
      code: "egress_pool_failed",
      message: `sandbox egress-health: reading the egress pool failed - ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** The pool's slots and addresses with the active cooldowns folded in. */
export async function readEgressHealth(
  opts: { provider?: string; model?: string },
  deps: EgressHealthDeps = {},
): Promise<EgressHealthReport> {
  const provider = opts.provider ?? DEFAULT_EGRESS_HEALTH_PROVIDER
  const ledger = deps.ledger ?? egressHealthLedger
  const pool = await readPool(provider, deps)
  if (!pool.ok) return pool
  const cooldowns = ledger.list(opts.model !== undefined ? { model: opts.model } : {})
  return {
    ok: true,
    provider,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    slots: pool.slots.map(slot => ({
      slot: slot.id,
      publicIp: slot.publicIp,
      ...(slot.computers !== undefined ? { computers: slot.computers } : {}),
      cooling: cooldowns.filter(c => c.publicIp === slot.publicIp),
    })),
    cooldowns,
  }
}

export type EgressProbeSlotResult =
  | { slot: string; publicIp?: string; verdict: "ok" | "ko" | "unknown"; detail: string; cleared?: number; cooldown?: EgressCooldownEntry }
  | { slot: string; verdict: "error"; detail: string }

export type EgressProbeReport =
  | { ok: true; provider: string; model: string; adapter: string; results: EgressProbeSlotResult[] }
  | Extract<EgressHealthReport, { ok: false }>

export interface EgressProbeDeps extends EgressHealthDeps {
  preflightRegistry?: PreflightRegistry
  /** Per-slot probe budget, ms. Defaults to the probe's own budget. */
  timeoutMs?: number
}

/**
 * Boot one box per slot, run `model-answers` for `model` from it, then stop
 * the box. A `ko` that is a usage or rate limit sets the cooldown; an `ok`
 * clears every cooldown on that address for the model; `unknown` and boot
 * errors change nothing. Every slot's box boots in parallel: each is a real
 * boot, so probing sequentially made a full sweep take minutes.
 */
export async function probeEgressSlots(
  opts: { provider?: string; model: string; adapter?: string },
  deps: EgressProbeDeps = {},
): Promise<EgressProbeReport> {
  const provider = opts.provider ?? DEFAULT_EGRESS_HEALTH_PROVIDER
  const adapter = opts.adapter ?? "opencode"
  const ledger = deps.ledger ?? egressHealthLedger
  const pool = await readPool(provider, deps)
  if (!pool.ok) return pool
  const resolver = deps.resolveSandboxProvider ?? makeSandboxResolver(makeSandboxCredsStore())
  const handle = await resolver(provider)
  if (!handle?.provider.boot) {
    return {
      ok: false,
      code: "egress_provider_not_found",
      message: `sandbox egress-health: provider "${provider}" cannot boot a probe box`,
    }
  }

  const results = await Promise.all(
    pool.slots.map(async (slot): Promise<EgressProbeSlotResult> => {
      // 1 GiB is enough for one `opencode run`; models.dev must be reachable or
      // opencode hangs silently on model metadata and looks like a throttled IP.
      const spec: SandboxSpec = {
        provider,
        config: {
          egressIp: slot.id,
          cpus: 1,
          memoryMiB: 1024,
          egress: ["opencode.ai", "models.opencode.ai", "models.dev", "rdv.agentproto.sh", "registry.npmjs.org"],
        },
      }
      let booted: Awaited<ReturnType<NonNullable<typeof handle.provider.boot>>> | undefined
      try {
        booted = await handle.provider.boot(spec, { env: {} })
        if (!booted.exec) {
          return { slot: slot.id, verdict: "error", detail: `provider "${provider}" boxes cannot run commands` }
        }
        const publicIp = booted.egressIp?.publicIp ?? slot.publicIp
        const run = await runSandboxPreflight(
          [MODEL_ANSWERS_PROBE_ID],
          { exec: booted.exec, adapter, model: opts.model, egressIp: publicIp },
          { registry: deps.preflightRegistry ?? defaultPreflightRegistry, ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}) },
        )
        const outcome = run.failed ?? run.outcomes[0]
        if (!outcome) {
          return { slot: slot.id, publicIp, verdict: "unknown", detail: "no probe ran" }
        }
        if (outcome.verdict === "ok") {
          const cleared = ledger.clear({ publicIp, model: opts.model })
          return { slot: slot.id, publicIp, verdict: "ok", detail: outcome.detail, cleared }
        }
        if (outcome.verdict === "ko" && isEgressHealthErrorClass(outcome.errorClass)) {
          const cooldown = ledger.mark({
            publicIp,
            model: opts.model,
            errorClass: outcome.errorClass,
            slot: slot.id,
            source: `probe:${MODEL_ANSWERS_PROBE_ID}`,
          })
          return { slot: slot.id, publicIp, verdict: "ko", detail: outcome.detail, cooldown }
        }
        return { slot: slot.id, publicIp, verdict: outcome.verdict, detail: outcome.detail }
      } catch (err) {
        return { slot: slot.id, verdict: "error", detail: err instanceof Error ? err.message : String(err) }
      } finally {
        if (booted) await booted.stop().catch(() => undefined)
      }
    }),
  )
  return { ok: true, provider, model: opts.model, adapter, results }
}

export const sandboxEgressHealthInputShape = {
  provider: z
    .string()
    .optional()
    .describe(`Sandbox provider slug whose egress pool to read. Defaults to "${DEFAULT_EGRESS_HEALTH_PROVIDER}".`),
  model: z.string().optional().describe("Narrow the cooldowns to one model id."),
}
export const sandboxEgressHealthInputSchema = z.object(sandboxEgressHealthInputShape)

export const sandboxEgressProbeInputSchema = z.object({
  provider: z.string().optional(),
  model: z.string().min(1),
  adapter: z.string().optional(),
})

export interface RegisterSandboxEgressHealthToolOptions {
  resolveSandboxProvider?: SandboxProviderResolver
}

/** Register the read-only `sandbox_egress_health` MCP tool. */
export function registerSandboxEgressHealthTool(
  server: McpServer,
  opts: RegisterSandboxEgressHealthToolOptions = {},
): void {
  server.tool(
    "sandbox_egress_health",
    "List a sandbox provider's egress address pool (slot id, public IP, boxes in use) with the " +
      "active per-IP model cooldowns. A free-tier model cap is enforced per source IP; a slot whose " +
      "address is cooling down for a model is skipped when a box boots with `egressIp: auto`. " +
      "Read-only: it boots nothing. To re-probe every slot (boots one box each) use " +
      "`agentproto sandbox egress-health --probe <model>`.",
    sandboxEgressHealthInputShape,
    async input => {
      const report = await readEgressHealth(
        { ...(input.provider !== undefined ? { provider: input.provider } : {}), ...(input.model !== undefined ? { model: input.model } : {}) },
        { ...(opts.resolveSandboxProvider ? { resolveSandboxProvider: opts.resolveSandboxProvider } : {}) },
      )
      return {
        content: [{ type: "text", text: JSON.stringify(report) }],
        ...(report.ok ? {} : { isError: true }),
      }
    },
  )
}
