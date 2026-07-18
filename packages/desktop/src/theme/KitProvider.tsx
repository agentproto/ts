// React KitProvider — the runtime that applies a ported design kit to `:root`.
//
// Equivalent to the studio design-kit's KitProvider (packages/design-kit/src/
// runtime/provider.tsx) and the MOCK's `applyKit()`: on mount / kit change it
// flattens the active kit's tokens to CSS vars and sets them on
// document.documentElement. `useKit()` exposes the active kit + `setKit()` so a
// switcher can re-skin the whole shell live.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { DEFAULT_KIT_SLUG, KITS, toCssVars, type Kit } from "./kit"

export interface KitContextValue {
  /** Slug of the active kit. */
  slug: string
  /** The active kit's full definition. */
  kit: Kit
  /** The full registry, for a switcher to enumerate. */
  kits: Record<string, Kit>
  /** Switch the active kit by slug (no-op for an unknown slug). */
  setKit: (slug: string) => void
}

const KitContext = createContext<KitContextValue | null>(null)

interface KitProviderProps {
  children: ReactNode
  /** Slug to apply first; falls back to the agentproto default if unknown. */
  initialSlug?: string
}

export function KitProvider({ children, initialSlug = DEFAULT_KIT_SLUG }: KitProviderProps) {
  const [slug, setSlug] = useState(() => (KITS[initialSlug] ? initialSlug : DEFAULT_KIT_SLUG))
  const kit = KITS[slug] ?? KITS[DEFAULT_KIT_SLUG]

  useEffect(() => {
    const vars = toCssVars(kit.tokens)
    const root = document.documentElement
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value)
    }
  }, [kit])

  const setKit = useCallback((next: string) => {
    if (KITS[next]) setSlug(next)
  }, [])

  const value = useMemo<KitContextValue>(
    () => ({ slug, kit, kits: KITS, setKit }),
    [slug, kit, setKit],
  )

  return <KitContext.Provider value={value}>{children}</KitContext.Provider>
}

export function useKit(): KitContextValue {
  const ctx = useContext(KitContext)
  if (!ctx) throw new Error("useKit must be used within a <KitProvider>")
  return ctx
}
