import { describe, expect, it } from "vitest"
import { claudeCode } from "../index.js"
import { claudeCodeNativeHooks } from "../native-hooks.js"

const EXPECTED = [
  ["prompt-submit", "UserPromptSubmit", "admission", true],
  ["permission-request", "PermissionRequest", "admission", true],
  ["compact-start", "PreCompact", "admission", true],
  ["compact-end", "PostCompact", "lifecycle", false],
  ["subagent-start", "SubagentStart", "lifecycle", false],
  ["subagent-end", "SubagentStop", "admission", true],
  ["tool-call", "PreToolUse", "admission", true],
  ["tool-result", "PostToolUse", "lifecycle", false],
  ["turn-end", "Stop", "admission", true],
  ["conversation-start", "SessionStart", "lifecycle", false],
  ["conversation-end", "SessionEnd", "lifecycle", false],
]

describe("claude-code native hook declarations", () => {
  it("exposes the declaration on the handle", () => {
    expect(claudeCode.capabilities?.hooks).toBe(claudeCodeNativeHooks)
  })

  it("declares exactly the 11 matrix entries", () => {
    expect(claudeCodeNativeHooks).toHaveLength(11)
    expect(
      claudeCodeNativeHooks.map(hook => [
        hook.event,
        hook.native_event,
        hook.path,
        hook.can_block,
      ]),
    ).toEqual(EXPECTED)
  })

  it("has no turn-start entry", () => {
    expect(
      claudeCodeNativeHooks.some(hook => hook.event === "turn-start"),
    ).toBe(false)
  })

  it("keeps lifecycle non-blocking and blocking only on admission", () => {
    for (const hook of claudeCodeNativeHooks) {
      if (hook.path === "lifecycle") expect(hook.can_block).toBe(false)
      if (hook.can_block) expect(hook.path).toBe("admission")
    }
  })

  it("does not repeat an event and native_event pair", () => {
    const pairs = claudeCodeNativeHooks.map(
      hook => `${hook.event}\u0000${hook.native_event}`,
    )
    expect(new Set(pairs).size).toBe(pairs.length)
  })
})
