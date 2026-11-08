// Public kit names mapped to the data-kit attribute values the stylesheet
// selects on. Any other kit name is used as the attribute value as-is.
const KIT_ATTRIBUTES = { paper: "workshop", graphite: "forge" }

export const KITS = [
  { value: "paper-light", label: "Paper light" },
  { value: "paper-dark", label: "Paper dark" },
  { value: "graphite-light", label: "Graphite light" },
  { value: "graphite-dark", label: "Graphite dark" },
]

function requireStorageKey(storageKey) {
  if (typeof storageKey !== "string" || storageKey === "") {
    throw new TypeError("kit: storageKey is required (a non-empty string)")
  }
}

export function applyKit(value, storageKey) {
  requireStorageKey(storageKey)
  const [kit, mode] = String(value).split("-")
  document.documentElement.dataset.kit = Object.hasOwn(KIT_ATTRIBUTES, kit) ? KIT_ATTRIBUTES[kit] : kit
  document.documentElement.dataset.mode = mode
  document.documentElement.style.colorScheme = mode
  try {
    localStorage.setItem(storageKey, value)
  } catch {
    void 0
  }
}

export function initialKit(search, storageKey) {
  requireStorageKey(storageKey)
  const params = new URLSearchParams(search)
  const fromUrl =
    params.get("kit") && params.get("mode")
      ? `${params.get("kit")}-${params.get("mode")}`
      : null
  if (fromUrl) return fromUrl
  const fallback =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "paper-dark"
      : "paper-light"
  try {
    return localStorage.getItem(storageKey) || fallback
  } catch {
    return fallback
  }
}
