/**
 * Egress mode registry — describes how outbound traffic from an agent
 * sandbox is controlled at the network boundary.
 *
 * Four canonical modes ship by default; hosts can `extend` with
 * custom modes for their own infra. Bootstrap consumers branch on
 * the mode's **declarative flags**, never on the id, so adding a
 * new mode never edits a switch.
 *
 * # Mode hierarchy (weakest → strongest)
 *   off          — no controls. Real credentials in agent env. Today's default.
 *   cooperative  — agent sees `$$SECRET[NAME]$$` placeholders + BASE_URL envs
 *                  + HTTP_PROXY env. Substituted by host's egress proxy at
 *                  network boundary. Bypassable from inside (libs that
 *                  ignore HTTP_PROXY); but agent has no real credentials.
 *   strict       — cooperative + sandbox-level network enforcement (iptables
 *                  NAT to local sidecar, or HTTP_PROXY enforced by container
 *                  runtime). Agent literally cannot reach the network
 *                  except via the proxy.
 *   paranoid     — strict + TLS-MITM at the sidecar. Even calls to unknown
 *                  destinations get intercepted. Catches anything new the
 *                  agent might attempt.
 *
 * Hosts pick which modes are exposed to which guilds via their own
 * tier/policy system (Guilde uses `PlanPolicy.egressModes`).
 */

export type EgressModeId = "off" | "cooperative" | "strict" | "paranoid"

export interface EgressModeDefinition {
  id: EgressModeId
  label: string
  description: string
  /** Surface-level state. UI shows a "preview" badge when not stable. */
  status: "stable" | "preview" | "experimental"
  /**
   * Declarative bootstrap behavior. Bootstrap consumers branch on these
   * flags, not on the id, so adding a new mode never edits a switch.
   */
  emitsPlaceholders: boolean
  emitsBaseUrlEnvs: boolean
  emitsHttpProxyEnvs: boolean
  /**
   * Sandbox runtime requirements. When the host's runtime can't satisfy
   * these (e.g. managed e2b without NET_ADMIN), the mode is unavailable
   * AND the bootstrap should refuse to silently degrade — surface the
   * shortfall so the operator can pick a different mode explicitly.
   */
  requiresSandboxNetCap: boolean
  requiresMitmCa: boolean
}

/**
 * Composable registry. Mirror of `EntitlementRegistry` shape from
 * `@agstudio/core`/billing — same chainable methods so hosts can
 * customize without forking the default set.
 */
export class EgressModeRegistry {
  private readonly entries = new Map<EgressModeId, EgressModeDefinition>()

  register(def: EgressModeDefinition): this {
    this.entries.set(def.id, def)
    return this
  }

  get(id: EgressModeId): EgressModeDefinition | undefined {
    return this.entries.get(id)
  }

  getAll(): EgressModeDefinition[] {
    return [...this.entries.values()]
  }

  /** Append entries from another source. Later wins on id collision. */
  extend(defs: readonly EgressModeDefinition[]): this {
    for (const def of defs) this.register(def)
    return this
  }

  /** Drop entries by id. Useful for hosts that want to forbid a built-in. */
  without(...ids: readonly EgressModeId[]): this {
    for (const id of ids) this.entries.delete(id)
    return this
  }
}

/**
 * Default registry pre-loaded with the four canonical modes. Hosts
 * import this directly OR call `new EgressModeRegistry().extend(DEFAULT_EGRESS_MODES)`
 * to start from a clean slate they own.
 */
export const DEFAULT_EGRESS_MODES: readonly EgressModeDefinition[] = [
  {
    id: "off",
    label: "Direct (off)",
    description:
      "No egress controls. Real credentials injected into agent env / files. Lowest latency; widest blast radius if the agent leaks.",
    status: "stable",
    emitsPlaceholders: false,
    emitsBaseUrlEnvs: false,
    emitsHttpProxyEnvs: false,
    requiresSandboxNetCap: false,
    requiresMitmCa: false,
  },
  {
    id: "cooperative",
    label: "Cooperative",
    description:
      "Agent sees only $$SECRET[NAME]$$ placeholders. Real credentials substituted at the host's egress proxy. Network bypassable by libs that ignore HTTP_PROXY, but the agent has nothing real to bypass with.",
    status: "stable",
    emitsPlaceholders: true,
    emitsBaseUrlEnvs: true,
    emitsHttpProxyEnvs: true,
    requiresSandboxNetCap: false,
    requiresMitmCa: false,
  },
  {
    id: "strict",
    label: "Strict",
    description:
      "Cooperative + sandbox-level enforcement (iptables NAT or runtime-level proxy mandate). Agent cannot reach the network except via the proxy.",
    status: "preview",
    emitsPlaceholders: true,
    emitsBaseUrlEnvs: true,
    emitsHttpProxyEnvs: true,
    requiresSandboxNetCap: true,
    requiresMitmCa: false,
  },
  {
    id: "paranoid",
    label: "Paranoid",
    description:
      "Strict + TLS-MITM at the sidecar. Catches any outbound call, including to destinations the host didn't anticipate. Breaks SDKs with cert pinning.",
    status: "preview",
    emitsPlaceholders: true,
    emitsBaseUrlEnvs: true,
    emitsHttpProxyEnvs: true,
    requiresSandboxNetCap: true,
    requiresMitmCa: true,
  },
]

/** Convenience factory — most hosts use this directly. */
export function createDefaultEgressModeRegistry(): EgressModeRegistry {
  return new EgressModeRegistry().extend(DEFAULT_EGRESS_MODES)
}
