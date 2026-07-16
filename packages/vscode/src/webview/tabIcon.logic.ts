/**
 * Which SVG a transcript TAB wears for a session's activity — pure, no vscode
 * import, so the mapping is unit-testable and the asset names can be asserted
 * to exist on disk.
 *
 * Why hand-drawn SVGs at all, when the tree renders the same states from
 * codicons for free: `WebviewPanel.iconPath` takes a `Uri`, not a `ThemeIcon`.
 * A tab icon is fetched as an IMAGE, which has two consequences the tree never
 * faces:
 *   - No theming. `currentColor` resolves to black, so a neutral glyph needs a
 *     file per theme; only the semantic colours (warning, error) can share one.
 *   - No CSS. A spinner has to animate from inside the document, hence the
 *     `animateTransform` in working-*.svg.
 *
 * That makes these files a SECOND copy of an alphabet that already exists in
 * sessionsTree.logic.ts's ACTIVITY_ICONS — a real cost, taken deliberately so
 * a tab strip full of hours-old transcripts says which agent is working and
 * which one wants you. It's kept honest by deriving from the same
 * `SessionActivity`: a new state cannot compile without choosing its icon
 * here, and a test asserts every file this maps to is actually shipped.
 */

import type { SessionActivity } from "../views/sessionsTree.logic.js"

/** Paths are relative to the extension root (see MEDIA_DIR). */
export interface TabIconPaths {
  light: string
  dark: string
}

export const TAB_ICON_DIR = ["media", "session"] as const

/**
 * Mirrors ACTIVITY_ICONS, glyph for glyph:
 *   ○ hollow = at rest · ○ spinning = in motion · ✓ done · ⊘ stopped · ✗ failed
 * Warning-coloured states ship one file (they read on either theme); neutral
 * ones ship two, because nothing themes an <img>.
 */
const TAB_ICONS: Record<SessionActivity, TabIconPaths> = {
  idle: { light: "idle-light.svg", dark: "idle-dark.svg" },
  working: { light: "working-light.svg", dark: "working-dark.svg" },
  done: { light: "done-light.svg", dark: "done-dark.svg" },
  stopped: { light: "stopped-light.svg", dark: "stopped-dark.svg" },
  "needs-you": { light: "needs-you.svg", dark: "needs-you.svg" },
  stalled: { light: "stalled.svg", dark: "stalled.svg" },
  failed: { light: "failed.svg", dark: "failed.svg" },
}

/**
 * The filled dot — same footprint as `idle`, more weight (idle-*.svg is r 3.4
 * plus a 1.2 stroke, which lands on the filled dot's r 4).
 *
 * A tab and a tree row are the same session, so they must not disagree about
 * whether it's holding anything new. This earns its keep where the tree can't
 * help: a BACKGROUND transcript tab, open for hours, is exactly where "has
 * this said anything since I looked?" is worth a glyph. The focused tab is
 * read by definition, so its dot stays hollow — which is the honest answer,
 * not a special case.
 */
const IDLE_UNREAD_ICON: TabIconPaths = {
  light: "idle-unread-light.svg",
  dark: "idle-unread-dark.svg",
}

/**
 * Icon for a tab wearing this activity. `unread` reaches the idle dot only,
 * and an absent receipt paints filled — same rules as the tree's iconFor, for
 * the same reasons.
 */
export function tabIconFor(activity: SessionActivity, unread?: boolean): TabIconPaths {
  if (activity === "idle") return unread === false ? TAB_ICONS.idle : IDLE_UNREAD_ICON
  return TAB_ICONS[activity]
}

/** Every distinct file this module can point at — the test's shipping list. */
export function allTabIconFiles(): string[] {
  const files = new Set<string>()
  for (const paths of [...Object.values(TAB_ICONS), IDLE_UNREAD_ICON]) {
    files.add(paths.light)
    files.add(paths.dark)
  }
  return [...files].sort()
}
