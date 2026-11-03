/**
 * The pi extension that applies per-session provider overrides (see
 * `./provider-overrides.ts`). pi loads it via `pi -e
 * <dist>/provider-overrides-extension.mjs`; CLI `-e` extensions load even
 * under `--no-extensions`, so the lean mode keeps it. It reads the config path
 * from `PI_PROVIDER_OVERRIDES_CONFIG` and calls `pi.registerProvider(name,
 * { apiKey, headers })` per provider: an override without `models` keeps the
 * provider's built-in models and baseUrl, and pi resolves the `$ENV`
 * references against its own process env at request time.
 *
 * Imports nothing from `@earendil-works/*` (structural typing, like the MCP
 * bridge extension).
 */

import { readFileSync } from "node:fs"
import {
  PROVIDER_OVERRIDES_CONFIG_ENV,
  parseProviderOverridesConfig,
  type PiProviderOverride,
} from "./provider-overrides.js"

interface PiProviderExtensionAPI {
  registerProvider: (name: string, config: PiProviderOverride) => void
}

export default function providerOverridesExtension(pi: PiProviderExtensionAPI): void {
  const path = process.env[PROVIDER_OVERRIDES_CONFIG_ENV]
  if (!path) return
  const config = parseProviderOverridesConfig(JSON.parse(readFileSync(path, "utf8")))
  for (const [name, override] of Object.entries(config.providers)) {
    pi.registerProvider(name, override)
  }
}
