import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentCliParticipant } from "../participant-agent-cli.js"

describe("AgentCliParticipant", () => {
  it("resolves role paths relative to baseDir", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agent-cli-role-"))
    try {
      await writeFile(join(tmp, "role.md"), "You are a helpful reviewer.")
      const promptFile = join(tmp, "prompt.txt")
      const fakeCli = join(tmp, "fake-cli")
      await writeFile(
        fakeCli,
        `#!/bin/sh\ncat > "${promptFile}"\necho '{"result":"ok"}'`,
        { mode: 0o755 }
      )

      const participant = new AgentCliParticipant({
        command: fakeCli,
        baseDir: tmp,
        parseOutput: () => "ok",
      })

      const output = await participant.executeTurn({
        participant: {
          id: "reviewer",
          displayName: "Reviewer",
          executor: "agent-cli",
          role: "./role.md",
        },
        recentTurns: [],
        triggerTurn: {
          id: "t1",
          participantId: "user",
          content: "hi",
          timestamp: "2026-01-01T00:00:00Z",
        },
        state: {},
      })

      expect(output.content).toBe("ok")
      const prompt = await readFile(promptFile, "utf8")
      expect(prompt).toContain("You are a helpful reviewer.")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it("treats relative role paths as cwd-relative when baseDir is omitted", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agent-cli-role-"))
    try {
      const originalCwd = process.cwd()
      process.chdir(tmp)
      await writeFile(join(tmp, "role.md"), "You are a local expert.")
      const promptFile = join(tmp, "prompt.txt")
      const fakeCli = join(tmp, "fake-cli")
      await writeFile(
        fakeCli,
        `#!/bin/sh\ncat > "${promptFile}"\necho '{"result":"ok"}'`,
        { mode: 0o755 }
      )

      const participant = new AgentCliParticipant({
        command: fakeCli,
        parseOutput: () => "ok",
      })

      await participant.executeTurn({
        participant: {
          id: "expert",
          displayName: "Expert",
          executor: "agent-cli",
          role: "./role.md",
        },
        recentTurns: [],
        triggerTurn: {
          id: "t1",
          participantId: "user",
          content: "hi",
          timestamp: "2026-01-01T00:00:00Z",
        },
        state: {},
      })

      const prompt = await readFile(promptFile, "utf8")
      expect(prompt).toContain("You are a local expert.")
      process.chdir(originalCwd)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it("passes inline role text through unchanged", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agent-cli-role-"))
    try {
      const promptFile = join(tmp, "prompt.txt")
      const fakeCli = join(tmp, "fake-cli")
      await writeFile(
        fakeCli,
        `#!/bin/sh\ncat > "${promptFile}"\necho '{"result":"ok"}'`,
        { mode: 0o755 }
      )

      const participant = new AgentCliParticipant({
        command: fakeCli,
        baseDir: tmp,
        parseOutput: () => "ok",
      })

      await participant.executeTurn({
        participant: {
          id: "helper",
          displayName: "Helper",
          executor: "agent-cli",
          role: "You are an AI/ML specialist.",
        },
        recentTurns: [],
        triggerTurn: {
          id: "t1",
          participantId: "user",
          content: "hi",
          timestamp: "2026-01-01T00:00:00Z",
        },
        state: {},
      })

      const prompt = await readFile(promptFile, "utf8")
      expect(prompt).toContain("You are an AI/ML specialist.")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
