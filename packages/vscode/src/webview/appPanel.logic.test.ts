import { describe, expect, it } from "vitest"

import {
  appStandaloneUrl,
  appUiToolId,
  appViewResourceUri,
  builtinViewResourceUri,
} from "./appPanel.logic.js"
import { WORK_BOARD_APP_ID, WORK_BOARD_TOOL_ID } from "@agentproto/apps/work-board/panel"

describe("appUiToolId", () => {
  // Mirrors packages/runtime app-ui-apps.ts's appUiToolId — the daemon side
  // that mints the resource id these tests must stay in lockstep with.
  it("slugs a plain app id", () => {
    expect(appUiToolId("mail-triage")).toBe("app_ui_mail_triage")
  })

  it("strips an @owner/ scope", () => {
    expect(appUiToolId("@acme/media-viewer")).toBe("app_ui_media_viewer")
    expect(appUiToolId("@agentproto/mail-triage")).toBe("app_ui_mail_triage")
    expect(appUiToolId("@agentik/clipsmith")).toBe("app_ui_clipsmith")
  })

  it("maps every non [a-z0-9] character to _", () => {
    expect(appUiToolId("My App.v2")).toBe("app_ui__y__pp_v2")
  })
})

describe("appViewResourceUri", () => {
  it("builds the ui://<id>/view resource uri", () => {
    expect(appViewResourceUri("mail-triage")).toBe("ui://app_ui_mail_triage/view")
    expect(appViewResourceUri("@agentproto/mail-triage")).toBe("ui://app_ui_mail_triage/view")
  })
})

describe("builtinViewResourceUri", () => {
  it("prefers the catalog's own resourceUri", () => {
    expect(
      builtinViewResourceUri({
        toolId: "agentproto_work_board",
        resourceUri: "ui://agentproto_work_board/view",
      }),
    ).toBe("ui://agentproto_work_board/view")
  })

  it("falls back to building the uri from toolId", () => {
    expect(builtinViewResourceUri({ toolId: "agentproto_work_board" })).toBe(
      "ui://agentproto_work_board/view",
    )
  })

  it("returns undefined when the entry carries neither", () => {
    expect(builtinViewResourceUri({})).toBeUndefined()
    expect(builtinViewResourceUri({ toolId: "  ", resourceUri: "" })).toBeUndefined()
  })

  // The bug this replaced: openWorkBoard went through app_list (installed
  // apps only, never builtins) and then would have derived the installed-app
  // uri. A builtin registers under its OWN tool id, so the two differ — if
  // they ever converge, appViewResourceUri would have been fine all along.
  it("differs from the installed-app uri for the work board", () => {
    expect(builtinViewResourceUri({ toolId: WORK_BOARD_TOOL_ID })).not.toBe(
      appViewResourceUri(WORK_BOARD_APP_ID),
    )
    expect(appViewResourceUri(WORK_BOARD_APP_ID)).toBe("ui://app_ui_work_board/view")
  })
})

describe("appStandaloneUrl", () => {
  it("builds the standalone HTTP route with the appId URL-encoded", () => {
    expect(appStandaloneUrl("http://127.0.0.1:18790", "@agentproto/mail-triage")).toBe(
      "http://127.0.0.1:18790/apps/%40agentproto%2Fmail-triage/ui",
    )
    expect(appStandaloneUrl("http://127.0.0.1:18790/", "@agentik/clipsmith")).toBe(
      "http://127.0.0.1:18790/apps/%40agentik%2Fclipsmith/ui",
    )
  })

  it("strips a trailing slash from the daemon url", () => {
    expect(appStandaloneUrl("http://localhost:18790/", "plain-app")).toBe(
      "http://localhost:18790/apps/plain-app/ui",
    )
  })

  it("keeps an appId without a scope slash intact", () => {
    expect(appStandaloneUrl("http://localhost:18790", "plain-app")).toBe(
      "http://localhost:18790/apps/plain-app/ui",
    )
  })
})