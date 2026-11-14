/**
 * Native hook capabilities for the Codex harness.
 *
 * These entries mirror the codex column of
 * docs/design/action-hooks-capability-matrix.md (Step 4). They are
 * descriptive metadata read from the vendor documentation: nothing here
 * installs a hook or writes any config.
 */

import type { NativeHookCapability } from "@agentproto/harness"

export const codexNativeHooks: readonly NativeHookCapability[] = [
  {
    event: "prompt-submit",
    native_event: "UserPromptSubmit",
    path: "admission",
    can_block: true,
    handlers: ["command", "mcp"],
    async: true,
    context: "append",
  },
  {
    event: "permission-request",
    native_event: "PermissionRequest",
    path: "admission",
    can_block: true,
    handlers: ["command", "mcp"],
    async: true,
    context: "none",
  },
  {
    event: "compact-start",
    native_event: "PreCompact",
    path: "admission",
    can_block: true,
    handlers: ["command", "mcp"],
    async: true,
    context: "none",
  },
  {
    event: "compact-end",
    native_event: "PostCompact",
    path: "lifecycle",
    can_block: false,
    handlers: ["command", "mcp"],
    async: true,
    context: "none",
  },
  {
    event: "subagent-start",
    native_event: "SubagentStart",
    path: "lifecycle",
    can_block: false,
    handlers: ["command", "mcp"],
    async: true,
    context: "append",
  },
  {
    event: "subagent-end",
    native_event: "SubagentStop",
    path: "admission",
    can_block: true,
    handlers: ["command", "mcp"],
    async: true,
    context: "none",
  },
  {
    event: "tool-call",
    native_event: "PreToolUse",
    path: "admission",
    can_block: true,
    handlers: ["command", "mcp"],
    async: true,
    context: "append",
  },
  {
    event: "tool-result",
    native_event: "PostToolUse",
    path: "lifecycle",
    can_block: false,
    handlers: ["command", "mcp"],
    async: true,
    context: "append",
  },
  {
    event: "turn-end",
    native_event: "Stop",
    path: "admission",
    can_block: true,
    handlers: ["command", "mcp"],
    async: true,
    context: "none",
  },
  {
    event: "conversation-start",
    native_event: "SessionStart",
    path: "lifecycle",
    can_block: false,
    handlers: ["command", "mcp"],
    async: true,
    context: "append",
  },
  {
    event: "conversation-end",
    native_event: "SessionEnd",
    path: "lifecycle",
    can_block: false,
    handlers: ["command"],
    async: false,
    context: "none",
  },
]
