/**
 * The setup wizard's resume ledger, `~/.agentproto/setup/_onboarding.json`.
 * Lives next to the per-adapter AIP-29 ledgers (`setup/<slug>.json`); the
 * leading underscore can't collide with a lower-kebab adapter slug.
 */

import { join } from "node:path"

export interface OnboardingLedgerAction {
  id: string
  status: "applied" | "failed" | "skipped"
  detail?: string
}

export interface OnboardingLedgerStep {
  status: "ok" | "incomplete"
  at: string
  actions: OnboardingLedgerAction[]
}

export interface OnboardingLedger {
  startedAt: string
  steps: Record<string, OnboardingLedgerStep>
}

export function onboardingLedgerPath(home: string): string {
  return join(home, ".agentproto", "setup", "_onboarding.json")
}

/** Parse ledger text; a missing or malformed ledger is an empty one. */
export function parseOnboardingLedger(raw: string | null, now: string): OnboardingLedger {
  const empty: OnboardingLedger = { startedAt: now, steps: {} }
  if (raw === null) return empty
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return empty
    const startedAt: unknown = Reflect.get(parsed, "startedAt")
    const steps: unknown = Reflect.get(parsed, "steps")
    const out: OnboardingLedger = { startedAt: typeof startedAt === "string" ? startedAt : now, steps: {} }
    if (typeof steps === "object" && steps !== null) {
      for (const [id, entry] of Object.entries(steps)) {
        if (typeof entry !== "object" || entry === null) continue
        const status: unknown = Reflect.get(entry, "status")
        const at: unknown = Reflect.get(entry, "at")
        const actions: unknown = Reflect.get(entry, "actions")
        out.steps[id] = {
          status: status === "ok" ? "ok" : "incomplete",
          at: typeof at === "string" ? at : now,
          actions: Array.isArray(actions)
            ? actions.flatMap((a): OnboardingLedgerAction[] => {
                if (typeof a !== "object" || a === null) return []
                const aid: unknown = Reflect.get(a, "id")
                const st: unknown = Reflect.get(a, "status")
                const detail: unknown = Reflect.get(a, "detail")
                if (typeof aid !== "string" || (st !== "applied" && st !== "failed" && st !== "skipped")) return []
                return [{ id: aid, status: st, ...(typeof detail === "string" ? { detail } : {}) }]
              })
            : [],
        }
      }
    }
    return out
  } catch {
    return empty
  }
}
