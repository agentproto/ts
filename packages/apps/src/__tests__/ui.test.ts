import { describe, it, expect } from "vitest"
import { MEDIA_VIEWER_HTML, MEDIA_VIEWER_TOOLS } from "../media-viewer/ui.js"
import { MAIL_TRIAGE_HTML, MAIL_TRIAGE_TOOLS, MAIL_TRIAGE_MCP_ALIASES } from "../mail-triage/ui.js"
import { OPS_PANEL_HTML, OPS_PANEL_TOOLS } from "../ops-panel/ui.js"
import { SESSION_VIEWER_HTML, SESSION_VIEWER_TOOLS } from "../session-viewer/ui.js"

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

describe("session-viewer UI panel", () => {
  it("is a non-empty self-contained HTML document using the McpApp bridge", () => {
    expect(SESSION_VIEWER_HTML.length).toBeGreaterThan(0)
    expect(SESSION_VIEWER_HTML).toContain("<!DOCTYPE html>")
    expect(SESSION_VIEWER_HTML).toContain("McpApp.connect")
  })

  it("declares the read-only session/conversation tools it dispatches through app_tool_call", () => {
    expect(SESSION_VIEWER_TOOLS).toEqual(["session_list", "conversation_read"])
    for (const tool of SESSION_VIEWER_TOOLS) {
      expect(SESSION_VIEWER_HTML).toContain(tool)
    }
  })

  it("never talks to the daemon outside the McpApp bridge", () => {
    expect(SESSION_VIEWER_HTML).not.toMatch(/\bfetch\s*\(/)
  })
})

describe("ops-panel UI panel", () => {
  it("is a non-empty self-contained HTML document using the McpApp bridge", () => {
    expect(OPS_PANEL_HTML.length).toBeGreaterThan(0)
    expect(OPS_PANEL_HTML).toContain("<!DOCTYPE html>")
    expect(OPS_PANEL_HTML).toContain("McpApp.connect")
  })

  it("declares every daemon tool it dispatches through app_tool_call", () => {
    expect(OPS_PANEL_TOOLS).toEqual([
      "daemon_health",
      "session_list",
      "agent_start",
      "agent_prompt",
      "agent_kill",
      "session_restart",
      "session_archive",
      "session_gc",
      "cron_list",
      "cron_create",
      "cron_delete",
      "cron_run",
      "worktree_gc",
    ])
    for (const tool of OPS_PANEL_TOOLS) {
      expect(OPS_PANEL_HTML).toContain(tool)
    }
  })

  it("never talks to the daemon outside the McpApp bridge", () => {
    expect(OPS_PANEL_HTML).not.toMatch(/\bfetch\s*\(/)
  })
})
