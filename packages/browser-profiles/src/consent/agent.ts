/**
 * The agent-path surface (AIP-63 C7, plan F4). An agent may refresh inside a
 * grant and revoke. It cannot grant, add a domain, change the profile or add a
 * sink: each attempt is refused with a typed error and appended as a `deny` row.
 */

import type { ConsentHost } from "./host.js"
import { ConsentRequiredError } from "./errors.js"
import { grantServesDevice, type Grant } from "./grants.js"
import type { LedgerActor } from "./ledger.js"

export interface AgentSyncInput {
  grantId: string
  /** Accepted only when identical to the grant's own domains. Anything else is a refused widening. */
  domains?: readonly string[]
  /** Accepted only when identical to the grant's own profile. */
  profile?: string
}

export interface AgentConsentSurface {
  /** `session_sync_from_chrome`: refresh within the grant. Cannot add a domain or change profile. */
  sync(input: AgentSyncInput): Promise<{ grantId: string; cookieCount: number }>
  revoke(grantId: string): Promise<void>
  /** Always refused: only a human consent path creates a grant. */
  grant(input: { sessionId: string; domains?: readonly string[] }): Promise<never>
  addSink(input: { grantId: string; providerId: string }): Promise<never>
}

export function createAgentConsentSurface(host: ConsentHost, who: { deviceId?: string; via?: string } = {}): AgentConsentSurface {
  const actor: LedgerActor = {
    kind: "agent",
    ...(who.via ? { via: who.via } : {}),
    ...(who.deviceId ? { deviceId: who.deviceId } : {}),
  }
  const own = (grantId: string): Grant => {
    const g = host.getGrant(grantId)
    if (!g || !grantServesDevice(g, who.deviceId)) throw new ConsentRequiredError()
    return g
  }
  const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
    const left = new Set(a.map(x => x.toLowerCase()))
    const right = new Set(b.map(x => x.toLowerCase()))
    return left.size === right.size && [...left].every(x => right.has(x))
  }

  return {
    async sync(input) {
      const grant = own(input.grantId)
      const base = { actor, grantId: grant.id, sessionId: grant.sessionId }
      if (input.profile !== undefined && input.profile !== grant.source.profile) {
        host.refuseAgent("change the Chrome profile of a grant", base)
      }
      if (input.domains !== undefined && !sameSet(input.domains, grant.domains ?? [])) {
        host.refuseAgent("add a domain to a grant", { ...base, domains: input.domains })
      }
      const { cookieCount } = await host.refresh(grant.id, { actor })
      return { grantId: grant.id, cookieCount }
    },
    async revoke(grantId) {
      own(grantId)
      await host.revoke(grantId, { actor })
    },
    async grant(input) {
      return host.refuseAgent("grant access to a Chrome profile", {
        actor,
        sessionId: input.sessionId,
        ...(input.domains ? { domains: input.domains } : {}),
      })
    },
    async addSink(input) {
      const g = own(input.grantId)
      return host.refuseAgent("add a sink to a grant", { actor, grantId: g.id, sessionId: g.sessionId })
    },
  }
}
