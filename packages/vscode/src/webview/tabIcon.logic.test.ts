import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { SessionActivity } from "../views/sessionsTree.logic.js"
import { allTabIconFiles, TAB_ICON_DIR, tabIconFor } from "./tabIcon.logic.js"

/**
 * The extension root — vitest runs each package from its own directory.
 * Deliberately process.cwd() and not a module-relative path: `import.meta` is
 * rejected by this package's CJS tsc target, and `__dirname` doesn't exist in
 * the ESM vitest runs. A wrong cwd can't pass silently — every existsSync
 * below would fail.
 */
const iconPath = (file: string): string => join(process.cwd(), ...TAB_ICON_DIR, file)

/** Every activity the tree can classify. A new one must choose a tab icon. */
const ALL_ACTIVITIES: SessionActivity[] = [
  "needs-you",
  "stalled",
  "working",
  "idle",
  "failed",
  "stopped",
  "done",
]

describe("tabIconFor", () => {
  it("covers every activity — a tab can never fall back to a generic glyph", () => {
    for (const activity of ALL_ACTIVITIES) {
      const icon = tabIconFor(activity)
      expect(icon.light, activity).toBeTruthy()
      expect(icon.dark, activity).toBeTruthy()
    }
  })

  it("ships every file it points at", () => {
    // The whole risk of a second, hand-drawn alphabet is that it drifts from
    // the code that names it. A missing file is silent at runtime — VS Code
    // just shows no icon — so it has to fail here instead.
    for (const file of allTabIconFiles()) {
      expect(existsSync(iconPath(file)), `${file} is missing from media/session/`).toBe(true)
    }
  })

  it("never uses currentColor — a tab icon is an <img> and would render black", () => {
    // This is the trap that makes tab icons different from the tree's
    // codicons: nothing themes them. media/activitybar.svg IS currentColor,
    // which is correct for the activity bar and would be invisible here.
    for (const file of allTabIconFiles()) {
      expect(readFileSync(iconPath(file), "utf8"), file).not.toContain("currentColor")
    }
  })

  it("gives neutral glyphs a file per theme, and semantic ones a shared file", () => {
    // Neutral = drawn in the theme's foreground, so it needs two files.
    for (const activity of ["idle", "working", "done", "stopped"] as const) {
      const icon = tabIconFor(activity)
      expect(icon.light, activity).not.toBe(icon.dark)
    }
    // Warning/error read on either theme — a second file would be a second
    // thing to keep in sync for no gain.
    for (const activity of ["needs-you", "stalled", "failed"] as const) {
      const icon = tabIconFor(activity)
      expect(icon.light, activity).toBe(icon.dark)
    }
  })

  it("keeps the spinner spinning from inside the file — no CSS reaches a tab icon", () => {
    const svg = readFileSync(iconPath(tabIconFor("working").dark), "utf8")
    expect(svg).toContain("animateTransform")
    // And it still reads as in-progress if SMIL is ever ignored: the arc is a
    // partial ring, never a full circle that would look idle.
    expect(svg).toContain("A5.5 5.5 0 0 1")
  })

  it("matches the tree's alphabet — same states, same meanings", () => {
    // idle is a dot, working is a ring, done is a check, stopped is a slash.
    expect(tabIconFor("idle").dark).toContain("idle")
    expect(tabIconFor("working").dark).toContain("working")
    expect(tabIconFor("done").dark).toContain("done")
    expect(tabIconFor("stopped").dark).toContain("stopped")
    expect(tabIconFor("failed").dark).toBe("failed.svg")
  })

  it("wears the read-receipt too, so a tab and its tree row never disagree", () => {
    expect(tabIconFor("idle", true)).toEqual({
      light: "idle-unread-light.svg",
      dark: "idle-unread-dark.svg",
    })
    expect(tabIconFor("idle", false)).toEqual({ light: "idle-light.svg", dark: "idle-dark.svg" })
    // No receipt paints filled — hiding new output is the worse failure.
    expect(tabIconFor("idle")).toEqual(tabIconFor("idle", true))
  })

  it("keeps unread off every other state, exactly as the tree does", () => {
    for (const activity of ["working", "done", "stopped", "needs-you", "stalled", "failed"] as const) {
      expect(tabIconFor(activity, true), activity).toEqual(tabIconFor(activity, false))
    }
  })

  it("draws the read dot hollow and the unread dot filled", () => {
    // Weight is the entire signal, so it has to actually be in the file: the
    // read dot is a stroke with no fill, the unread one is a solid fill.
    const read = readFileSync(iconPath(tabIconFor("idle", false).dark), "utf8")
    expect(read).toContain('fill="none"')
    expect(read).toContain("stroke=")

    const unread = readFileSync(iconPath(tabIconFor("idle", true).dark), "utf8")
    expect(unread).toMatch(/<circle[^>]*fill="#/)
    expect(unread).not.toContain("stroke=")
  })

  it("keeps both dots the same size, so weight is the only difference", () => {
    // r 3.4 + a 1.2 stroke straddling it = an outer radius of 4, which is the
    // filled dot's r. A read dot that changed footprint would read as a
    // different KIND of thing rather than a quieter one.
    const read = readFileSync(iconPath(tabIconFor("idle", false).dark), "utf8")
    const unread = readFileSync(iconPath(tabIconFor("idle", true).dark), "utf8")
    const radius = (svg: string): number => Number(/r="([\d.]+)"/.exec(svg)![1])
    const strokeWidth = (svg: string): number => Number(/stroke-width="([\d.]+)"/.exec(svg)?.[1] ?? 0)
    expect(radius(read) + strokeWidth(read) / 2).toBeCloseTo(radius(unread))
  })
})
