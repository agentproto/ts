/**
 * Eligibility gate for a LIVE model switch (`registry.setModel` /
 * `agent_set_model`). Rotation already refuses a target the session's rules
 * forbid (`turn-retry.ts` + `turn-retry-eligibility.ts`), but a manual switch
 * historically bypassed those checks: it could move a free session onto a
 * paid id or onto a model the profile's allow-list excludes. This composes
 * the same guards for the manual path — the pure "free stays free" rule
 * straight from `turn-retry-policy.ts` (same wording as
 * `rotationTargetRejection`), everything else delegated to
 * `createRotationTargetCheck` so the two paths cannot drift apart.
 */

import type { AuthProfile } from "@agentproto/auth"
import type { CatalogModelsLister } from "./http-server.js"
import type { SessionDescriptor } from "./sessions.js"
import { isOpencodeFreeModel } from "./turn-retry-policy.js"
import { createRotationTargetCheck } from "./turn-retry-eligibility.js"

export function createModelSwitchCheck(deps: {
  getProfile: (id: string) => Promise<AuthProfile | undefined>
  listCatalogModels?: CatalogModelsLister
}): (
  desc: SessionDescriptor,
  modelId: string,
  info: { advertised: boolean },
) => Promise<string | undefined> {
  const rotationCheck = createRotationTargetCheck(deps)
  return async (desc, modelId, info) => {
    if (desc.model && isOpencodeFreeModel(desc.model) && !isOpencodeFreeModel(modelId)) {
      return "paid model — a free session never switches onto a paid id"
    }
    if (info.advertised) return undefined
    return rotationCheck(desc, { model: modelId })
  }
}
