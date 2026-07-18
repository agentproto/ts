// Ported design-kit runtime (standalone — NO @agstudio/* dependency).
//
// Mirrors the studio design-kit shape (packages/design-kit/src/{parse,css}.ts)
// and the MOCK's `applyKit()`: a DESIGN.md-shaped token object
// ({ colors, typography, rounded, spacing }) is flattened to CSS custom
// properties (--color-* / --font-* / --rounded-* / --spacing-*) and written to
// `:root`. Swap the kit → the whole shell re-skins. Every component's CSS reads
// these vars only; there are zero hardcoded brand colors downstream.

/** A token tree node: either a leaf string value or a nested section. */
export type TokenNode = string | { [key: string]: TokenNode }

/** The four token sections a kit declares. Values are leaf strings, except
 *  typography whose entries are `{ family }` records (matching the studio
 *  DESIGN.md authoring shape). */
export interface KitTokens {
  colors: Record<string, string>
  typography: Record<string, { family: string }>
  rounded: Record<string, string>
  spacing: Record<string, string>
}

/** A named, applyable kit. */
export interface Kit {
  slug: string
  label: string
  tokens: KitTokens
}

/** Recursively flatten a token node into `--prefix-key[-subkey…]: value`.
 *  `flatten("--color", { accent: "#10B981" }, out)` → out["--color-accent"].
 *  `flatten("--font", { body: { family: "Inter" } }, out)` →
 *  out["--font-body-family"]. */
function flatten(prefix: string, node: TokenNode, out: Record<string, string>): void {
  if (typeof node === "string") {
    out[prefix] = node
    return
  }
  for (const [key, child] of Object.entries(node)) {
    flatten(`${prefix}-${key}`, child, out)
  }
}

/** Flatten a kit's tokens to the CSS-var map applied on `:root`. Section →
 *  var prefix: colors→--color, typography→--font, rounded→--rounded,
 *  spacing→--spacing. */
export function toCssVars(tokens: KitTokens): Record<string, string> {
  const out: Record<string, string> = {}
  flatten("--color", tokens.colors, out)
  flatten("--font", tokens.typography, out)
  flatten("--rounded", tokens.rounded, out)
  flatten("--spacing", tokens.spacing, out)
  return out
}

// Layout spacing is not brand-specific — kept identical across kits so the
// grid geometry stays stable while colors/type/radius re-skin.
const SPACING: Record<string, string> = { xs: ".5rem", sm: "1rem", md: "1.5rem" }

/** The agentproto default kit — emerald #10B981 on #0A0A0A, JetBrains Mono
 *  display. Values are the MOCK's `agentproto` kit verbatim. This is the frozen
 *  token contract WP1..4 style against. */
export const AGENTPROTO_KIT: Kit = {
  slug: "agentproto",
  label: "Agent Protocol (default)",
  tokens: {
    colors: {
      background: "#0A0A0A",
      surface: "#141414",
      "surface-raised": "#1e1e1e",
      "surface-hi": "#262626",
      ink: "#FAFAFA",
      "ink-muted": "rgba(250,250,250,.58)",
      "ink-faint": "rgba(250,250,250,.34)",
      accent: "#10B981",
      "accent-fg": "#0A0A0A",
      border: "rgba(255,255,255,.09)",
      "border-strong": "rgba(255,255,255,.18)",
      success: "#10B981",
      warning: "#E0B23A",
      danger: "#F2664A",
      info: "#38BDF8",
    },
    typography: {
      body: { family: "'Inter',-apple-system,system-ui,sans-serif" },
      mono: { family: "'JetBrains Mono',ui-monospace,'SF Mono',monospace" },
      h1: { family: "'JetBrains Mono',ui-monospace,monospace" },
    },
    rounded: { sm: "0px", md: "2px", lg: "4px", full: "9999px" },
    spacing: SPACING,
  },
}

/** Slate — soft dark, indigo accent, rounded corners. From the MOCK. */
export const SLATE_KIT: Kit = {
  slug: "slate",
  label: "Slate (soft dark)",
  tokens: {
    colors: {
      background: "#0f1216",
      surface: "#161a20",
      "surface-raised": "#1d232b",
      "surface-hi": "#262d37",
      ink: "#e9edf3",
      "ink-muted": "rgba(233,237,243,.6)",
      "ink-faint": "rgba(233,237,243,.38)",
      accent: "#7c9cff",
      "accent-fg": "#0b0e14",
      border: "rgba(255,255,255,.08)",
      "border-strong": "rgba(255,255,255,.16)",
      success: "#4bcf7a",
      warning: "#e2b23c",
      danger: "#f0644a",
      info: "#54c7ff",
    },
    typography: {
      body: { family: "-apple-system,system-ui,sans-serif" },
      mono: { family: "ui-monospace,'SF Mono',monospace" },
      h1: { family: "-apple-system,system-ui,sans-serif" },
    },
    rounded: { sm: "6px", md: "8px", lg: "10px", full: "9999px" },
    spacing: SPACING,
  },
}

/** Workshop — light, warm, burnt-orange accent. From the MOCK. Proves a
 *  light-mode kit re-skins the shell with no component CSS changes. */
export const WORKSHOP_KIT: Kit = {
  slug: "workshop",
  label: "Workshop (light, warm)",
  tokens: {
    colors: {
      background: "#f4f1ea",
      surface: "#ffffff",
      "surface-raised": "#f7f4ee",
      "surface-hi": "#efe9df",
      ink: "#241f19",
      "ink-muted": "rgba(36,31,25,.62)",
      "ink-faint": "rgba(36,31,25,.4)",
      accent: "#b8531f",
      "accent-fg": "#ffffff",
      border: "rgba(36,31,25,.1)",
      "border-strong": "rgba(36,31,25,.2)",
      success: "#2e8b4d",
      warning: "#b9861a",
      danger: "#c23b22",
      info: "#2563c9",
    },
    typography: {
      body: { family: "'Inter',-apple-system,system-ui,sans-serif" },
      mono: { family: "ui-monospace,'SF Mono',monospace" },
      h1: { family: "'Inter',system-ui,sans-serif" },
    },
    rounded: { sm: "5px", md: "8px", lg: "11px", full: "9999px" },
    spacing: SPACING,
  },
}

/** The kit registry, keyed by slug. Ships ≥2 kits so the titlebar switcher
 *  proves the token contract. */
export const KITS: Record<string, Kit> = {
  [AGENTPROTO_KIT.slug]: AGENTPROTO_KIT,
  [SLATE_KIT.slug]: SLATE_KIT,
  [WORKSHOP_KIT.slug]: WORKSHOP_KIT,
}

export const DEFAULT_KIT_SLUG = AGENTPROTO_KIT.slug
