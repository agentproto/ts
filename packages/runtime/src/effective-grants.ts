import type { Grant } from "@agentproto/policy"

import { loadConfig } from "./config.js"
import type { SpawnDefaultsConfig } from "./spawn-defaults.js"

/** One AIP-38 grant a configuration switch is equivalent to. */
export interface EffectiveGrant {
  source:
    | "defaults.messaging.allowSiblings"
    | "defaults.messaging.allowSameWorkspace"
    | "defaults.messaging.peerGroups"
    | "session.allowPromptFrom"
  grant: Grant
  /** false when the grant alone is broader than the configuration: the host also requires the pair condition in `pair`. */
  exact: boolean
  /** false when the grant is tied to a process that does not survive a restart (a target without an operator label). */
  portable: boolean
  pair?: "sibling" | "same-workspace" | "peer-group"
  /** The target session of a `session.allowPromptFrom` grant. */
  sessionId?: string
  note?: string
}

/** A configured entry that no AIP-38 grant expresses. */
export interface UnmappedEntry {
  source: "session.allowPromptFrom" | "defaults.tasks.operatorDelegates"
  entry: string
  sessionId?: string
  reason: string
}

export interface EffectiveGrantsInput {
  messaging: {
    allowSiblings: boolean
    allowSameWorkspace: boolean
    peerGroups: readonly (readonly string[])[]
    peerBinding: "slug" | "verified"
  }
  operatorDelegates: readonly string[]
  sessions: ReadonlyArray<{ id: string; operatorLabel?: string; allowPromptFrom?: readonly string[] }>
}

export interface EffectiveGrantsReport {
  grants: EffectiveGrant[]
  unmapped: UnmappedEntry[]
  inputs: EffectiveGrantsInput["messaging"]
}

const ANY = "*"

function messageGrant(scope?: string): Grant {
  return {
    principal: ANY,
    effect: "allow",
    actions: [scope === undefined ? { action: "session:message" } : { action: "session:message", scope }],
  }
}

export function deriveEffectiveGrants(input: EffectiveGrantsInput): EffectiveGrantsReport {
  const grants: EffectiveGrant[] = []
  const unmapped: UnmappedEntry[] = []
  const { messaging } = input

  if (messaging.allowSiblings) {
    grants.push({
      source: "defaults.messaging.allowSiblings",
      grant: messageGrant(),
      exact: false,
      portable: true,
      pair: "sibling",
      note: "Any sender, but the host applies it only to two children of one parent; a grant cannot name that pair.",
    })
  }
  if (messaging.allowSameWorkspace) {
    grants.push({
      source: "defaults.messaging.allowSameWorkspace",
      grant: messageGrant(),
      exact: false,
      portable: true,
      pair: "same-workspace",
      note:
        messaging.peerBinding === "verified"
          ? 'Any sender, applied by the host to two sessions whose working directories resolve to the same registered workspace (peerBinding "verified").'
          : 'Any sender, applied by the host to two sessions that recorded the same workspace slug, a spawn-supplied slug and the "default" bucket included (peerBinding "slug").',
    })
  }
  messaging.peerGroups.forEach((group, index) => {
    for (const slug of group) {
      grants.push({
        source: "defaults.messaging.peerGroups",
        grant: messageGrant(`workspace:${slug}`),
        exact: false,
        portable: true,
        pair: "peer-group",
        note: `Group ${index}: [${group.join(", ")}]. Any sender, applied by the host only when the sender is also bound to a workspace of the group.`,
      })
    }
  })

    for (const session of input.sessions) {
    const entries = session.allowPromptFrom ?? []
    if (entries.length === 0) continue
    const label = session.operatorLabel !== undefined && session.operatorLabel !== "" ? session.operatorLabel : undefined
    const scope = label !== undefined ? `label:${label}` : session.id
    for (const entry of entries) {
      let principal: string
      if (entry === "any") {
        principal = ANY
      } else if (entry.startsWith("label:")) {
        const value = entry.slice("label:".length)
        if (value === "" || value === "*") {
          unmapped.push({
            source: "session.allowPromptFrom",
            entry,
            sessionId: session.id,
            reason: "an empty label prefix matches nothing",
          })
          continue
        }
        if (value.endsWith("*")) {
          unmapped.push({
            source: "session.allowPromptFrom",
            entry,
            sessionId: session.id,
            reason: "AIP-38 principals are exact; a label prefix has no grant form",
          })
          continue
        }
        principal = `session-label://${value}`
      } else {
        unmapped.push({
          source: "session.allowPromptFrom",
          entry,
          sessionId: session.id,
          reason:
            "a session id names one process and does not survive a restart; it is not an AIP-23 principal. Give the caller an operator label and list label:<label> instead.",
        })
        continue
      }
      grants.push({
        source: "session.allowPromptFrom",
        grant: {
          principal,
          effect: "allow",
          actions: [
            { action: "session:prompt", scope },
            { action: "session:control", scope },
          ],
        },
        exact: false,
        portable: label !== undefined,
        sessionId: session.id,
        note: "A label grant is honored only when the caller has no parent; the host also applies that condition.",
      })
    }
  }

  for (const entry of input.operatorDelegates) {
    unmapped.push({
      source: "defaults.tasks.operatorDelegates",
      entry,
      reason: "gives the task ledger's operator rights, an action AIP-39 does not declare",
    })
  }
  return { grants, unmapped, inputs: { ...messaging } }
}

/** `defaults.tasks.operatorDelegates`, read per call; a missing or malformed config gives []. */
export async function resolveOperatorDelegates(
  loadCfg: () => Promise<{ defaults?: SpawnDefaultsConfig }> = loadConfig,
): Promise<string[]> {
  try {
    const list = (await loadCfg()).defaults?.tasks?.operatorDelegates
    return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string") : []
  } catch {
    return []
  }
}
