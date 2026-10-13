/**
 * Async half of `turnRetry.rotate` eligibility: the checks a SPAWN of the
 * target model would run, applied to a live session's descriptor — the
 * profile's model allow-list, the money-safety wallet guard, and the
 * adapter-capability guard (`checkModelAdapterEligibility`). The pure half
 * (cooldown, free stays free, same profile) lives in `turn-retry.ts`.
 */

import type { AuthProfile } from "@agentproto/auth"
import { getModelProvider } from "@agentproto/model-catalog/llm"
import { checkModelAdapterEligibility, checkModelWalletEligibility } from "./catalog-models.js"
import { profileServicesModel } from "./harness-preset-store.js"
import type { CatalogModelsLister } from "./http-server.js"
import { modelIdPrefixProvider } from "./spawn-defaults.js"
import type { RotationTargetCheck } from "./turn-retry.js"

export function createRotationTargetCheck(deps: {
  getProfile: (id: string) => Promise<AuthProfile | undefined>
  listCatalogModels?: CatalogModelsLister
}): RotationTargetCheck {
  return async (desc, target) => {
    const profileRef = desc.accessProfile?.profileRef
    if (profileRef) {
      const profile = await deps.getProfile(profileRef)
      if (!profile || profile.disabled) return `profile "${profileRef}" is ${profile ? "disabled" : "missing"}`
      if (!profileServicesModel(profile, target.model)) {
        return `not in profile "${profileRef}"'s model allow-list`
      }
    }
    // An explicit gateway is the operator naming a wallet — spawn does not
    // second-guess it, and neither does rotation.
    if (desc.route?.gateway !== undefined) return undefined
    const provider =
      desc.adapterProvider ??
      (desc.modelDerivedApiKey ? modelIdPrefixProvider(target.model) : undefined) ??
      getModelProvider(target.model)
    if (provider === undefined) return undefined
    if (!desc.modelDerivedApiKey) {
      const wallet = checkModelWalletEligibility(target.model, provider)
      if (!wallet.ok) return `route "${provider}" cannot bill it`
    }
    if (deps.listCatalogModels && desc.adapterSlug) {
      const verdict = checkModelAdapterEligibility(
        await deps.listCatalogModels({}),
        desc.adapterSlug,
        target.model,
        provider,
      )
      if (!verdict.ok) return `adapter "${desc.adapterSlug}" cannot serve it on route "${provider}"`
    }
    return undefined
  }
}
