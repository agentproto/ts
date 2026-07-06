import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerBuiltins } from "../builtins.js"
import { getExecutorFactory, _resetRegistryForTests } from "../runtime.js"

describe("builtins — agent-cli executor", () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerBuiltins()
  })

  afterEach(() => {
    _resetRegistryForTests()
  })

  it("defaults claude to --permission-mode bypassPermissions so unattended participants don't hang on tool prompts", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agent-cli-exec-"))
    try {
      const fakeClaude = join(tmp, "claude")
      const argvFile = join(tmp, "argv.txt")
      await writeFile(
        fakeClaude,
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\necho '{"result":"ok"}'`,
        { mode: 0o755 }
      )

      const originalPath = process.env.PATH
      process.env.PATH = `${tmp}${originalPath ? ":" + originalPath : ""}`

      const factory = getExecutorFactory("agent-cli")!
      const executor = await factory(
        { kind: "agent-cli" },
        { baseDir: tmp, registerCleanup: () => {} }
      )

      await executor.executeTurn({
        participant: {
          id: "p1",
          displayName: "P1",
          executor: "agent-cli",
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

      const argv = (await readFile(argvFile, "utf8"))
        .split("\n")
        .filter(Boolean)
      expect(argv).toContain("--permission-mode")
      expect(argv).toContain("bypassPermissions")
      expect(argv).toContain("--print")
      expect(argv).toContain("--output-format=json")

      process.env.PATH = originalPath
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it("injects --model when per-participant model is set for claude", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agent-cli-exec-"))
    try {
      const fakeClaude = join(tmp, "claude")
      const argvFile = join(tmp, "argv.txt")
      await writeFile(
        fakeClaude,
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\necho '{"result":"ok"}'`,
        { mode: 0o755 }
      )

      const originalPath = process.env.PATH
      process.env.PATH = `${tmp}${originalPath ? ":" + originalPath : ""}`

      const factory = getExecutorFactory("agent-cli")!
      const executor = await factory(
        { kind: "agent-cli", model: "sonnet" },
        { baseDir: tmp, registerCleanup: () => {} }
      )

      await executor.executeTurn({
        participant: {
          id: "p1",
          displayName: "P1",
          executor: "agent-cli",
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

      const argv = (await readFile(argvFile, "utf8"))
        .split("\n")
        .filter(Boolean)
      expect(argv).toContain("--model")
      expect(argv).toContain("sonnet")

      process.env.PATH = originalPath
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it("uses explicit args when provided", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agent-cli-exec-"))
    try {
      const fakeCli = join(tmp, "my-cli")
      const argvFile = join(tmp, "argv.txt")
      await writeFile(
        fakeCli,
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\necho '{"result":"ok"}'`,
        { mode: 0o755 }
      )

      const factory = getExecutorFactory("agent-cli")!
      const executor = await factory(
        { kind: "agent-cli", command: fakeCli, args: ["--custom"] },
        { baseDir: tmp, registerCleanup: () => {} }
      )

      await executor.executeTurn({
        participant: {
          id: "p1",
          displayName: "P1",
          executor: "agent-cli",
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

      const argv = (await readFile(argvFile, "utf8"))
        .split("\n")
        .filter(Boolean)
      expect(argv).toEqual(["--custom"])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
