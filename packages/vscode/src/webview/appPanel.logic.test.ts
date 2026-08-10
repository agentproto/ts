import { describe, expect, it } from "vitest"

import { appUiToolId, appViewResourceUri } from "./appPanel.logic.js"

describe("appUiToolId", () => {
  // Mirrors packages/runtime app-ui-apps.ts's appUiToolId — the daemon side
  // that mints the resource id these tests must stay in lockstep with.
  it("slugs a plain app id", () => {
    expect(appUiToolId("mail-triage")).toBe("app_ui_mail_triage")
  })

  it("strips an @owner/ scope", () => {
    expect(appUiToolId("@acme/media-viewer")).toBe("app_ui_media_viewer")
  })

  it("maps every non [a-z0-9] character to _", () => {
    expect(appUiToolId("My App.v2")).toBe("app_ui__y__pp_v2")
  })
})

describe("appViewResourceUri", () => {
  it("builds the ui://<id>/view resource uri", () => {
    expect(appViewResourceUri("mail-triage")).toBe("ui://app_ui_mail_triage/view")
  })
})
