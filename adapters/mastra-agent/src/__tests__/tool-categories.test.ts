import { describe, expect, it } from "vitest"

import { DEFAULT_PERMISSION_RULES, toolCategoryResolver } from "../tool-categories.js"

describe("toolCategoryResolver", () => {
  it("maps read tools", () => {
    expect(toolCategoryResolver("list_dir")).toBe("read")
    expect(toolCategoryResolver("read_file")).toBe("read")
    expect(toolCategoryResolver("read_diff")).toBe("read")
  })
  it("maps edit tools", () => {
    expect(toolCategoryResolver("write_file")).toBe("edit")
    expect(toolCategoryResolver("edit_file")).toBe("edit")
    expect(toolCategoryResolver("apply_patch")).toBe("edit")
  })
  it("maps execute tools", () => {
    expect(toolCategoryResolver("run_command")).toBe("execute")
    expect(toolCategoryResolver("run_tests")).toBe("execute")
  })
  it("maps daemon verbs to mcp", () => {
    expect(toolCategoryResolver("agent_start")).toBe("mcp")
    expect(toolCategoryResolver("agent_prompt")).toBe("mcp")
    expect(toolCategoryResolver("agent_output")).toBe("mcp")
    expect(toolCategoryResolver("session_list")).toBe("mcp")
  })
  it("maps the signal-provider watch tools to read (subscription-only, no reach-out)", () => {
    expect(toolCategoryResolver("watch_session")).toBe("read")
    expect(toolCategoryResolver("unwatch_session")).toBe("read")
  })
  it("maps the notification inbox to read (inbox bookkeeping only)", () => {
    expect(toolCategoryResolver("notification-inbox")).toBe("read")
  })
  it("maps submit_plan to other", () => {
    expect(toolCategoryResolver("submit_plan")).toBe("other")
  })
  it("returns null for unknown tool ids", () => {
    expect(toolCategoryResolver("search_web")).toBeNull()
    expect(toolCategoryResolver("")).toBeNull()
  })
})

describe("DEFAULT_PERMISSION_RULES", () => {
  it("allows read and asks for everything else", () => {
    expect(DEFAULT_PERMISSION_RULES.categories.read).toBe("allow")
    expect(DEFAULT_PERMISSION_RULES.categories.edit).toBe("ask")
    expect(DEFAULT_PERMISSION_RULES.categories.execute).toBe("ask")
    expect(DEFAULT_PERMISSION_RULES.categories.mcp).toBe("ask")
    expect(DEFAULT_PERMISSION_RULES.categories.other).toBe("ask")
  })
  it("allows submit_plan through the generic gate (it gates itself via suspend)", () => {
    expect(DEFAULT_PERMISSION_RULES.tools).toEqual({ submit_plan: "allow" })
  })
})
