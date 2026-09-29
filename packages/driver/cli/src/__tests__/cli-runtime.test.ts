import { describe, it, expect } from "vitest"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { runTool } from "@agentproto/driver"
import { defineCliDriver, expandArgv } from "../index.js"

function cwdTool() {
  return defineTool({
    id: "cwd-tool",
    description: "returns process.cwd() as JSON",
    inputSchema: z.object({}),
    outputSchema: z.object({ cwd: z.string() }),
  })
}

function cwdDriver(cwd?: string) {
  return defineCliDriver({
    id: "cwd-cli",
    name: "cwd",
    description: "x",
    kind: "cli",
    bin: process.execPath,
    output: { defaultFormat: "json", exitCodes: { 0: "ok" } },
    cwd,
    implements: [
      {
        tool: "./tools/cwd-tool/TOOL.md",
        version: "^1",
        metadata: {
          cli: { argv: ["-e", "process.stdout.write(JSON.stringify({cwd: process.cwd()}))"] },
        },
      },
    ],
  })
}

describe("expandArgv", () => {
  it("substitutes ${input.X}", () => {
    expect(
      expandArgv(["pr", "create", "--title", "${input.title}"], {
        input: { title: "Fix bug" },
        secrets: {},
      })
    ).toEqual(["pr", "create", "--title", "Fix bug"])
  })

  it("supports default filter", () => {
    expect(
      expandArgv(["${input.base | default('main')}"], {
        input: {},
        secrets: {},
      })
    ).toEqual(["main"])
  })

  it("supports flag filter (truthy → append, falsy → skip)", () => {
    expect(
      expandArgv(["create", "${input.draft | flag('--draft')}"], {
        input: { draft: true },
        secrets: {},
      })
    ).toEqual(["create", "--draft"])
    expect(
      expandArgv(["create", "${input.draft | flag('--draft')}"], {
        input: { draft: false },
        secrets: {},
      })
    ).toEqual(["create"])
  })

  it("supports optional filter (set → flag+value, unset → skip)", () => {
    expect(
      expandArgv(["${input.head | optional('--head', input.head)}"], {
        input: { head: "feature/x" },
        secrets: {},
      })
    ).toEqual(["--head", "feature/x"])
    expect(
      expandArgv(["${input.head | optional('--head', input.head)}"], {
        input: {},
        secrets: {},
      })
    ).toEqual([])
  })

  it("supports multi-substitution literals", () => {
    expect(
      expandArgv(["release-${input.version}"], {
        input: { version: "1.2.3" },
        secrets: {},
      })
    ).toEqual(["release-1.2.3"])
  })
})

describe("defineCliDriver — end-to-end via runTool", () => {
  it("dispatches to a real subprocess (echo) and returns stdout", async () => {
    const tool = defineTool({
      id: "echo-tool",
      description: "echoes input",
      inputSchema: z.object({ msg: z.string() }),
      outputSchema: z.string(),
    })

    const provider = defineCliDriver({
      id: "echo-cli",
      name: "echo",
      description: "x",
      kind: "cli",
      bin: "echo",
      output: { defaultFormat: "text", exitCodes: { 0: "ok" } },
      implements: [
        {
          tool: "./tools/echo-tool/TOOL.md",
          version: "^1",
          metadata: { cli: { argv: ["${input.msg}"] } },
        },
      ],
    })

    const out = await runTool({
      tool,
      candidates: [provider],
      input: { msg: "hello" },
    })
    expect(typeof out).toBe("string")
    expect((out as string).trim()).toBe("hello")
  })

  it("maps non-zero exit codes to provider error semantics", async () => {
    const tool = defineTool({
      id: "false-tool",
      description: "always fails",
      inputSchema: z.object({}),
      outputSchema: z.unknown(),
    })

    const provider = defineCliDriver({
      id: "false-cli",
      name: "false",
      description: "x",
      kind: "cli",
      bin: "false",
      output: { exitCodes: { 0: "ok", 1: "auth_required" } },
      implements: [
        {
          tool: "./tools/false-tool/TOOL.md",
          version: "^1",
          metadata: { cli: { argv: [] } },
        },
      ],
    })

    await expect(
      runTool({ tool, candidates: [provider], input: {} })
    ).rejects.toMatchObject({ code: "auth_required" })
  })
})

describe("defineCliDriver — completes on the child's own exit, not on stdio close (F45)", () => {
  it("resolves quickly with the parsed output even when the subprocess leaves a detached grandchild holding stdout/stderr open", async () => {
    const tool = defineTool({
      id: "orphan-tool",
      description: "prints its JSON result, then leaves an orphaned grandchild inheriting stdio",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean(), path: z.string() }),
    })

    // Mirrors the real F45 repro: the script prints its result and exits —
    // its own work is done — but a grandchild it spawned (stdio: 'inherit',
    // detached: true, simulating a headless-Chrome renderer helper
    // reparented off this process) keeps the write end of stdout/stderr
    // open for 5s after. The old `close`-based completion would hang for
    // that whole window (6+ minutes in the live incident); the fix
    // completes as soon as THIS script's own process exits.
    const script = [
      "const { spawn } = require('node:child_process');",
      "process.stdout.write(JSON.stringify({ ok: true, path: '/tmp/out.pdf' }));",
      "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], " +
        "{ stdio: ['ignore', 'inherit', 'inherit'], detached: true });",
      "gc.unref();",
      "process.exit(0);",
    ].join(" ")

    const provider = defineCliDriver({
      id: "orphan-cli",
      name: "orphan",
      description: "x",
      kind: "cli",
      bin: process.execPath,
      output: { defaultFormat: "json", exitCodes: { 0: "ok" } },
      implements: [
        {
          tool: "./tools/orphan-tool/TOOL.md",
          version: "^1",
          metadata: { cli: { argv: ["-e", script] } },
        },
      ],
    })

    const start = Date.now()
    const out = await runTool({ tool, candidates: [provider], input: {} })
    expect(Date.now() - start).toBeLessThan(4000)
    expect(out).toEqual({ ok: true, path: "/tmp/out.pdf" })
  }, 8000)
})

describe("defineCliDriver — cwd", () => {
  it("without cwd, the subprocess inherits the host process's cwd (unchanged behaviour)", async () => {
    const out = await runTool({ tool: cwdTool(), candidates: [cwdDriver()], input: {} })
    expect(out).toEqual({ cwd: realpathSync(process.cwd()) })
  })

  it("with cwd set, the subprocess spawns in that directory", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cli-driver-cwd-")))
    try {
      const out = await runTool({ tool: cwdTool(), candidates: [cwdDriver(dir)], input: {} })
      expect(out).toEqual({ cwd: dir })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
