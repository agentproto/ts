/**
 * Native hook capabilities for the Gemini CLI harness.
 *
 * These entries mirror the gemini column of
 * docs/design/action-hooks-capability-matrix.md (Step 4). They are
 * descriptive metadata read from the vendor documentation: nothing here
 * installs a hook or writes any config.
 */

import type { NativeHookCapability } from "@agentproto/harness"

export const geminiNativeHooks: readonly NativeHookCapability[] = [
  {
    event: "prompt-submit",
    native_event: "BeforeAgent",
    path: "admission",
    can_block: true,
    handlers: ["command"],
    async: false,
    context: "append",
  },
  {
    event: "compact-start",
    native_event: "PreCompress",
    path: "lifecycle",
    can_block: false,
    handlers: ["command"],
    async: false,
    context: "none",
  },
  {
    event: "tool-call",
    native_event: "BeforeTool",
    path: "admission",
    can_block: true,
    handlers: ["command"],
    async: false,
    context: "none",
  },
  {
    event: "tool-result",
    native_event: "AfterTool",
    path: "lifecycle",
    can_block: false,
    handlers: ["command"],
    async: false,
    context: "append",
  },
  {
    event: "turn-end",
    native_event: "AfterAgent",
    path: "lifecycle",
    can_block: false,
    handlers: ["command"],
    async: false,
    context: "none",
  },
  {
    event: "conversation-start",
    native_event: "SessionStart",
    path: "lifecycle",
    can_block: false,
    handlers: ["command"],
    async: false,
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
