import { describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type PtyFactory } from "../sessions.js"

const fakePtyFactory: PtyFactory = () => ({
  pid: 4242,
  write: () => {},
  resize: () => {},
  kill: () => {},
  onData: () => {},
  onExit: () => {},
})

const TEST_ONLY_CANARY = "synthetic-resume-env-canary-not-a-credential"

function firstText(result: unknown): string {
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ""
  const first = content[0]
  return first && typeof first === "object" && "text" in first && typeof first.text === "string"
    ? first.text
    : ""
}

describe("session MCP descriptor redaction", () => {
  it("omits ptyResumeEnv from list(full), rename, and restart while retaining it internally for resume", async () => {
    const registry = createSessionsRegistry({ persist: false, spawnPty: fakePtyFactory })
    const server = new McpServer({ name: "redaction-test", version: "0" })
    registerSessionTools(server, { registry, workspace: process.cwd(), ptyEnabled: true })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "redaction-test-client", version: "0" })
    await client.connect(clientTransport)

    try {
      const original = registry.spawnPty({
        workspaceSlug: "default",
        cwd: process.cwd(),
        argv: ["bash"],
        cols: 80,
        rows: 24,
        env: { RESUME_CONFIG_DIR: TEST_ONLY_CANARY },
      })
      registry.kill(original.id)

      const list = await client.callTool({
        name: "session_list",
        arguments: { kind: "terminal", full: true },
      })
      const listText = firstText(list)
      const listed = JSON.parse(listText) as { sessions: Array<Record<string, unknown>> }
      expect(listed.sessions.find(row => row.id === original.id)).not.toHaveProperty("ptyResumeEnv")
      expect(listText).not.toContain(TEST_ONLY_CANARY)

      for (const [tool, args] of [
        ["terminal_sessions_list", { full: true }],
        ["command_list", { kind: "all", full: true }],
      ] as const) {
        const result = await client.callTool({ name: tool, arguments: args })
        const text = firstText(result)
        const page = JSON.parse(text) as { sessions: Array<Record<string, unknown>> }
        expect(page.sessions.find(row => row.id === original.id)).not.toHaveProperty("ptyResumeEnv")
        expect(text).not.toContain(TEST_ONLY_CANARY)
      }

      const renamed = await client.callTool({
        name: "session_rename",
        arguments: { idOrName: original.id, label: "redaction fixture" },
      })
      const renameText = firstText(renamed)
      expect(JSON.parse(renameText)).not.toHaveProperty("ptyResumeEnv")
      expect(renameText).not.toContain(TEST_ONLY_CANARY)

      const restarted = await client.callTool({
        name: "session_restart",
        arguments: { idOrName: original.id },
      })
      const restartText = firstText(restarted)
      const restartedDescriptor = JSON.parse(restartText) as { id: string }
      expect(restarted.isError).toBeFalsy()
      expect(restartText).not.toContain(TEST_ONLY_CANARY)
      expect(JSON.parse(restartText)).not.toHaveProperty("ptyResumeEnv")

      // Public serialization strips this field; the registry still needs it
      // to support another restart of the resumed PTY.
      const stored = registry.get(restartedDescriptor.id)
      expect(stored?.ptyResumeEnv).toBeDefined()
      expect(Object.values(stored?.ptyResumeEnv ?? {}).includes(TEST_ONLY_CANARY)).toBe(true)
    } finally {
      await client.close()
      registry.shutdown()
    }
  })
})
