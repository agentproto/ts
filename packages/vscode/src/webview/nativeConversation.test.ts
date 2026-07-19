import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadNativeConversation } from "./nativeConversation.js"
import type { SessionDescriptor } from "../client/types.js"

let fakeHome: string
let originalHome: string | undefined

afterEach(() => {
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
})

function setupFakeHome(cwd: string): string {
  originalHome = process.env.HOME
  fakeHome = mkdtempSync(join(tmpdir(), "native-conv-"))
  process.env.HOME = fakeHome
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-")
  const dir = join(fakeHome, ".claude", "projects", encoded)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeSession(overrides: Partial<SessionDescriptor>): SessionDescriptor {
  return {
    id: "sess_test",
    kind: "terminal",
    workspaceSlug: "default",
    command: "claude",
    pid: 1234,
    status: "running",
    startedAt: "2026-05-13T09:00:00.000Z",
    pty: true,
    ...overrides,
  }
}

describe("loadNativeConversation", () => {
  it("loads and projects a claude PTY transcript into structured records", async () => {
    const cwd = "/my/proj"
    const dir = setupFakeHome(cwd)
    const conversationId = "63e014d3-0000-0000-0000-000000000037"
    writeFileSync(
      join(dir, `${conversationId}.jsonl`),
      [
        {
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "thinking" },
              { type: "text", text: "world" },
              { type: "tool_use", name: "bash", input: { command: "ls" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt\nb.txt" }],
          },
        },
      ].map(line => JSON.stringify(line)).join("\n") + "\n",
    )

    const records = await loadNativeConversation(
      makeSession({
        argv: ["claude", "--resume", conversationId],
        cwd,
      }),
    )

    expect(records.map(r => r.kind)).toEqual([
      "user-prompt",
      "thought",
      "text-delta",
      "tool-call",
      "tool-result",
      "usage_snapshot",
    ])
    expect(records[0]).toMatchObject({ sessionId: "sess_test", text: "hello" })
    expect(records[3]).toMatchObject({ toolName: "bash", toolCallId: "native-1-0" })
    expect(records[4]).toMatchObject({ toolCallId: "native-1-0", result: "a.txt\nb.txt" })
  })
})
