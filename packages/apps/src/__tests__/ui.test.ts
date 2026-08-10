import { describe, it, expect } from "vitest"
import { MEDIA_VIEWER_HTML, MEDIA_VIEWER_TOOLS } from "../media-viewer/ui.js"
import { MAIL_TRIAGE_HTML, MAIL_TRIAGE_TOOLS, MAIL_TRIAGE_MCP_ALIASES } from "../mail-triage/ui.js"

describe("media-viewer UI panel", () => {
  it("is a non-empty self-contained HTML document using the McpApp bridge", () => {
    expect(MEDIA_VIEWER_HTML.length).toBeGreaterThan(0)
    expect(MEDIA_VIEWER_HTML).toContain("<!DOCTYPE html>")
    expect(MEDIA_VIEWER_HTML).toContain("McpApp.connect")
  })

  it("declares the daemon tools it dispatches through app_tool_call", () => {
    expect(MEDIA_VIEWER_TOOLS).toEqual(["directory_list", "file_info", "file_read"])
    for (const tool of MEDIA_VIEWER_TOOLS) {
      expect(MEDIA_VIEWER_HTML).toContain(tool)
    }
  })
})

describe("mail-triage UI panel", () => {
  it("is a non-empty self-contained HTML document using the McpApp bridge", () => {
    expect(MAIL_TRIAGE_HTML.length).toBeGreaterThan(0)
    expect(MAIL_TRIAGE_HTML).toContain("<!DOCTYPE html>")
    expect(MAIL_TRIAGE_HTML).toContain("McpApp.connect")
  })

  it("declares the imported mailbox tools plus the agent-run tools it dispatches", () => {
    expect(MAIL_TRIAGE_TOOLS).toEqual([
      ...MAIL_TRIAGE_MCP_ALIASES.flatMap((alias) => [
        `imported:${alias}/mailbox_list`,
        `imported:${alias}/mailbox_search`,
        `imported:${alias}/mailbox_triage_plan`,
        `imported:${alias}/mailbox_triage_apply`,
      ]),
      "app_run",
      "app_status",
      "agent_output",
      "app_list",
    ])
    // The panel builds `imported:<alias>/<tool>` ids at runtime from the
    // embedded alias list — assert the parts it composes them from.
    expect(MAIL_TRIAGE_HTML).toContain(JSON.stringify([...MAIL_TRIAGE_MCP_ALIASES]))
    for (const tool of ["mailbox_list", "mailbox_search", "mailbox_triage_plan", "mailbox_triage_apply", "app_run", "app_status", "agent_output", "app_list"]) {
      expect(MAIL_TRIAGE_HTML).toContain(tool)
    }
  })
})
