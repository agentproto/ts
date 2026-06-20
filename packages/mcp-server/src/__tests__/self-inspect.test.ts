import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selfInspect, summarizeToolRef, summarizeRoutineRef } from "../self-inspect-tool.js"

// ── helpers ─────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "agentproto-self-inspect-"))
}

const AGENT_MD = (extra = "") => `---
schema: agent/v1
id: test-agent
description: Agent used for self_inspect unit tests.
model: anthropic/claude-haiku-4-5-20251001
${extra}---

# Test Agent
`

const TOOL_MD = `---
schema: agentproto/tool/v1
id: echo
name: Echo
description: Echoes its input back.
version: 1.0.0
inputSchema:
  type: object
  properties:
    text:
      type: string
outputSchema:
  type: object
---

# Echo
`

const ROUTINE_MD = `---
schema: routine/v1
id: daily-ping
description: Fires the agent once a day.
version: 1.0.0
schedule:
  cron: "0 9 * * *"
target:
  action: ping
---

# Daily Ping
`

// ── summarizeToolRef ─────────────────────────────────────────────────────────

describe("summarizeToolRef", () => {
  it("surfaces string refs as-is", async () => {
    const result = await summarizeToolRef("@agentik/tools-standard/web-fetch", "/workspace")
    expect(result.id).toBe("@agentik/tools-standard/web-fetch")
  })

  it("loads file refs and extracts id + description", async () => {
    const ws = makeTmp()
    try {
      await mkdir(join(ws, "tools", "echo"), { recursive: true })
      await writeFile(join(ws, "tools", "echo", "TOOL.md"), TOOL_MD)

      const result = await summarizeToolRef({ file: "tools/echo/TOOL.md" }, ws)
      expect(result.id).toBe("echo")
      expect(result.description).toBe("Echoes its input back.")
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it("returns fallback when a file ref cannot be loaded", async () => {
    const result = await summarizeToolRef({ file: "tools/missing/TOOL.md" }, "/nonexistent")
    expect(result.id).toBe("tools/missing/TOOL.md")
    expect(result.description).toContain("could not load")
  })

  it("uses inline params directly", async () => {
    const result = await summarizeToolRef(
      { inline: { id: "my-tool", description: "An inline tool." } },
      "/workspace",
    )
    expect(result.id).toBe("my-tool")
    expect(result.description).toBe("An inline tool.")
  })

  it("surfaces ref: strings as-is", async () => {
    const result = await summarizeToolRef({ ref: "@scope/registry-tool" }, "/workspace")
    expect(result.id).toBe("@scope/registry-tool")
    expect(result.description).toContain("not locally resolved")
  })
})

// ── summarizeRoutineRef ──────────────────────────────────────────────────────

describe("summarizeRoutineRef", () => {
  it("loads file refs and extracts id + description", async () => {
    const ws = makeTmp()
    try {
      await mkdir(join(ws, ".routines", "daily-ping"), { recursive: true })
      await writeFile(join(ws, ".routines", "daily-ping", "ROUTINE.md"), ROUTINE_MD)

      const result = await summarizeRoutineRef({ file: ".routines/daily-ping/ROUTINE.md" }, ws)
      expect(result.id).toBe("daily-ping")
      expect(result.description).toBe("Fires the agent once a day.")
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

// ── selfInspect ──────────────────────────────────────────────────────────────

describe("selfInspect", () => {
  it("loads an AGENT.md with no tools or routines", async () => {
    const ws = makeTmp()
    try {
      await mkdir(join(ws, ".agents", "test-agent"), { recursive: true })
      await writeFile(join(ws, ".agents", "test-agent", "AGENT.md"), AGENT_MD())

      const result = await selfInspect("test-agent", ws)

      expect(result.agentPath).toBe(join(ws, ".agents", "test-agent", "AGENT.md"))
      expect(result.tools).toEqual([])
      expect(result.routines).toEqual([])
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it("resolves a string tool ref", async () => {
    const ws = makeTmp()
    try {
      await mkdir(join(ws, ".agents", "test-agent"), { recursive: true })
      await writeFile(
        join(ws, ".agents", "test-agent", "AGENT.md"),
        AGENT_MD('tools:\n  - "@agentik/tools-standard/web-fetch"\n'),
      )

      const result = await selfInspect("test-agent", ws)
      expect(result.tools).toHaveLength(1)
      expect(result.tools[0]!.id).toBe("@agentik/tools-standard/web-fetch")
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it("resolves a file: tool ref to id + description", async () => {
    const ws = makeTmp()
    try {
      await mkdir(join(ws, ".agents", "test-agent"), { recursive: true })
      await mkdir(join(ws, "tools", "echo"), { recursive: true })
      await writeFile(join(ws, "tools", "echo", "TOOL.md"), TOOL_MD)
      await writeFile(
        join(ws, ".agents", "test-agent", "AGENT.md"),
        AGENT_MD('tools:\n  - file: tools/echo/TOOL.md\n'),
      )

      const result = await selfInspect("test-agent", ws)
      expect(result.tools).toHaveLength(1)
      expect(result.tools[0]).toEqual({ id: "echo", description: "Echoes its input back." })
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it("resolves a file: routine ref to id + description", async () => {
    const ws = makeTmp()
    try {
      await mkdir(join(ws, ".agents", "test-agent"), { recursive: true })
      await mkdir(join(ws, ".routines", "daily-ping"), { recursive: true })
      await writeFile(join(ws, ".routines", "daily-ping", "ROUTINE.md"), ROUTINE_MD)
      await writeFile(
        join(ws, ".agents", "test-agent", "AGENT.md"),
        AGENT_MD('routines:\n  - file: .routines/daily-ping/ROUTINE.md\n'),
      )

      const result = await selfInspect("test-agent", ws)
      expect(result.routines).toHaveLength(1)
      expect(result.routines[0]).toEqual({
        id: "daily-ping",
        description: "Fires the agent once a day.",
      })
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it("throws with a clear message when the agent is not found", async () => {
    const ws = makeTmp()
    try {
      await expect(selfInspect("ghost", ws)).rejects.toThrow(
        /No AGENT\.md found for agent 'ghost'/,
      )
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})
