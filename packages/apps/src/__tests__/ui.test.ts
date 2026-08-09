import { describe, it, expect } from "vitest"
import { MEDIA_VIEWER_HTML, MEDIA_VIEWER_TOOLS } from "../media-viewer/ui.js"
import { MAIL_TRIAGE_HTML, MAIL_TRIAGE_TOOLS } from "../mail-triage/ui.js"

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
      "imported:agentpush/mailbox_list",
      "imported:agentpush/mailbox_search",
      "imported:agentpush/mailbox_triage_plan",
      "imported:agentpush/mailbox_triage_apply",
      "app_run",
      "app_status",
      "agent_output",
    ])
    for (const tool of MAIL_TRIAGE_TOOLS) {
      expect(MAIL_TRIAGE_HTML).toContain(tool)
    }
  })
})
