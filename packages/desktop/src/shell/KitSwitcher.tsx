// The titlebar kit picker — proves the token contract: choosing a kit re-skins
// the entire shell live via <KitProvider>. Enumerates the ported kit registry.

import { useKit } from "../theme/KitProvider"

export function KitSwitcher() {
  const { slug, kits, setKit } = useKit()
  return (
    <select
      className="kitpick"
      title="Applied design.md"
      value={slug}
      onChange={(e) => setKit(e.currentTarget.value)}
    >
      {Object.values(kits).map((kit) => (
        <option key={kit.slug} value={kit.slug}>
          ◇ {kit.label}
        </option>
      ))}
    </select>
  )
}
