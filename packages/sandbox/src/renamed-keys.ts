/**
 * AIP-36 renamed `config.installAdapters` to `config.installHarnesses`. The
 * generated schema leaves `config` open (provider-specific fields), so the old
 * key would validate and then install nothing. Every entry point that takes a
 * sandbox spec rejects it with this error, which names the new key.
 */
export const INSTALL_ADAPTERS_RENAMED =
  "`config.installAdapters` was renamed to `config.installHarnesses` (AIP-36); write `installHarnesses: [<slug>, ...]`"

/** The rename error for a spec still carrying a pre-rename key, else `undefined`. */
export function renamedSandboxKeyError(spec: { config?: unknown }): string | undefined {
  const config = spec.config
  if (config !== null && typeof config === "object" && "installAdapters" in config) {
    return INSTALL_ADAPTERS_RENAMED
  }
  return undefined
}
