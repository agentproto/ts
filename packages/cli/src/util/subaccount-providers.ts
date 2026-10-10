import { registerSubaccountProvider } from "@agentproto/auth"

/**
 * Register the sub-account providers that ship with the CLI. This is the one
 * place a provider is named: the runtime and `@agentproto/auth` only ever talk
 * to the registry. Lazy-imported so the common `auth` help path doesn't load
 * adapters.
 */
export async function registerBuiltinSubaccountProviders(): Promise<void> {
  const { opencodeSubaccounts } = await import("@agentproto/adapter-opencode")
  registerSubaccountProvider(opencodeSubaccounts)
}
