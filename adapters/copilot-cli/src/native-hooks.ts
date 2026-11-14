/**
 * Native hook capabilities for the GitHub Copilot CLI harness.
 *
 * These entries mirror the copilot-cli column of
 * docs/design/action-hooks-capability-matrix.md (Step 4). They are
 * descriptive metadata read from the vendor documentation: nothing here
 * installs a hook or writes any config.
 */

import type { NativeHookCapability } from "@agentproto/harness"

export const copilotCliNativeHooks: readonly NativeHookCapability[] = [
  {
    event: "prompt-submit",
    native_event: "userPromptSubmitted",
    path: "lifecycle",
    can_block: false,
    handlers: ["command", "http"],
    async: false,
    context: "none",
  },
  {
    event: "permission-request",
    native_event: "permissionRequest",
    path: "admission",
    can_block: true,
    handlers: ["command", "http"],
    async: false,
    context: "none",
  },
  {
    event: "compact-start",
    native_event: "preCompact",
    path: "lifecycle",
    can_block: false,
    handlers: ["command", "http"],
    async: false,
    context: "none",
  },
  {
    event: "subagent-start",
    native_event: "subagentStart",
    path: "lifecycle",
    can_block: false,
    handlers: ["command", "http"],
    async: false,
    context: "append",
  },
  {
    event: "subagent-end",
    native_event: "subagentStop",
    path: "admission",
    can_block: true,
    handlers: ["command", "http"],
    async: false,
    context: "none",
  },
  {
    event: "tool-call",
    native_event: "preToolUse",
    path: "admission",
    can_block: true,
    handlers: ["command", "http"],
    async: false,
    context: "none",
  },
  {
    event: "tool-result",
    native_event: "postToolUse",
    path: "lifecycle",
    can_block: false,
    handlers: ["command", "http"],
    async: false,
    context: "append",
  },
  {
    event: "turn-end",
    native_event: "agentStop",
    path: "admission",
    can_block: true,
    handlers: ["command", "http"],
    async: false,
    context: "none",
  },
  {
    event: "conversation-start",
    native_event: "sessionStart",
    path: "lifecycle",
    can_block: false,
    handlers: ["command", "http", "prompt"],
    async: false,
    context: "append",
  },
  {
    event: "conversation-end",
    native_event: "sessionEnd",
    path: "lifecycle",
    can_block: false,
    handlers: ["command", "http"],
    async: false,
    context: "none",
  },
]
