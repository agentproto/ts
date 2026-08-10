import { describe, expect, it } from "vitest"

import type { InstalledAppInfo } from "../client/types.js"
import { appDescription, appLabel, appsWithUi } from "./appsTree.logic.js"

function app(over: Partial<InstalledAppInfo> = {}): InstalledAppInfo {
  return { appId: "mail-triage", ...over }
}

describe("appsWithUi", () => {
  it("keeps only apps that ship a ui block", () => {
    const withUi = app({ appId: "with-ui", ui: { path: "/apps/ui.html" } })
    const without = app({ appId: "agents-only" })
    expect(appsWithUi([withUi, without])).toEqual([withUi])
  })

  it("returns empty for an empty registry", () => {
    expect(appsWithUi([])).toEqual([])
  })
})

describe("appLabel", () => {
  it("prefers the ui title", () => {
    expect(appLabel(app({ ui: { path: "p", title: "Mail Triage" } }))).toBe("Mail Triage")
  })

  it("falls back to the appId when the title is absent or blank", () => {
    expect(appLabel(app({ ui: { path: "p" } }))).toBe("mail-triage")
    expect(appLabel(app({ ui: { path: "p", title: "  " } }))).toBe("mail-triage")
  })
})

describe("appDescription", () => {
  it("prefers the ui description, then the app's own, then empty", () => {
    expect(
      appDescription(app({ description: "app desc", ui: { path: "p", description: "ui desc" } })),
    ).toBe("ui desc")
    expect(appDescription(app({ description: "app desc", ui: { path: "p" } }))).toBe("app desc")
    expect(appDescription(app({ ui: { path: "p" } }))).toBe("")
  })
})
