import type { BrowserProvider } from "./provider.js"

export interface BrowserRegistry {
  /** Register a provider. Throws when the id is already taken. */
  register(provider: BrowserProvider): void
  has(id: string): boolean
  get(id: string): BrowserProvider | undefined
  /** Like `get`, but throws a readable error listing known ids. */
  require(id: string): BrowserProvider
  /** All providers in registration order. */
  list(): BrowserProvider[]
}

export function createBrowserRegistry(
  initial: readonly BrowserProvider[] = [],
): BrowserRegistry {
  const providers = new Map<string, BrowserProvider>()
  const registry: BrowserRegistry = {
    register(provider) {
      if (providers.has(provider.id)) {
        throw new Error(`browser provider '${provider.id}' is already registered`)
      }
      providers.set(provider.id, provider)
    },
    has: (id) => providers.has(id),
    get: (id) => providers.get(id),
    require(id) {
      const found = providers.get(id)
      if (!found) {
        const known = [...providers.keys()].join(", ") || "none"
        throw new Error(`unknown browser provider '${id}' (registered: ${known})`)
      }
      return found
    },
    list: () => [...providers.values()],
  }
  for (const p of initial) registry.register(p)
  return registry
}
