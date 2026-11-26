/**
 * Voice and billing provider families on the daemon, riding on
 * `@agentproto/provider-kit`. The two registries are built by their own
 * packages (`makeVoiceRegistry`, `makeBillingRegistry`, both mounted with
 * `makeProviderFamily()`), so this module holds no provider and no catalog:
 * it only registers the tools their families produce.
 *
 *   - `list_voice_providers` / `setup_voice_provider`
 *   - `list_billing_providers` / `setup_billing_provider`
 *
 * Credentials for these families come from the host environment
 * (`<SLUG>_API_KEY`, `<RAIL>_SECRET_KEY`, ...). The registries read them
 * through the kit's read-only environment store, so a `setup_*` call answers
 * `ok: false` with a hint to set the variables on the host rather than
 * writing a secret to disk. No credential value is ever returned by `list_*`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { makeBillingRegistry, type BillingRegistry } from "@agentproto/billing"
import { makeVoiceRegistry, type VoiceRegistry } from "@agentproto/voice"

export interface RegisterVoiceBillingToolsOptions {
  /** Override the voice registry (tests, a host that bundles providers). */
  voiceRegistry?: VoiceRegistry
  /** Override the billing registry (tests, a host that bundles providers). */
  billingRegistry?: BillingRegistry
}

export async function registerVoiceBillingTools(
  server: McpServer,
  opts: RegisterVoiceBillingToolsOptions = {},
): Promise<void> {
  const voice = opts.voiceRegistry ?? makeVoiceRegistry()
  await voice.family.registerTools(server, {
    list: {
      name: "list_voice_providers",
      description:
        "List known voice providers with their status (supported/available/" +
        "ready), version, the stages each implements (stt, tts, realtime) and " +
        "the API key variable it reads. Credentials are never returned. Use " +
        "`setup_voice_provider` for how a provider is configured.",
    },
    setup: {
      name: "setup_voice_provider",
      description:
        "Configure a voice provider. Voice credentials are read from the " +
        "host environment (`<SLUG>_API_KEY`); when the family's store is " +
        "read-only this answers ok:false and names what to set on the host. " +
        "Field values are never echoed back.",
    },
  })

  const billing = opts.billingRegistry ?? makeBillingRegistry()
  await billing.family.registerTools(server, {
    list: {
      name: "list_billing_providers",
      description:
        "List known billing (settlement) providers with their status " +
        "(supported/available/ready), version, the secret/webhook/mode " +
        "variables each reads, and whether it can refund or sync a catalog. " +
        "Credentials are never returned. Use `setup_billing_provider` for how " +
        "a provider is configured.",
    },
    setup: {
      name: "setup_billing_provider",
      description:
        "Configure a billing provider. Credentials are read from the host " +
        "environment (`<RAIL>_SECRET_KEY`, `<RAIL>_WEBHOOK_SECRET`); when the " +
        "family's store is read-only this answers ok:false and names what to " +
        "set on the host. Field values are never echoed back.",
    },
  })
}
