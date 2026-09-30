/**
 * `agentproto daemon` on Windows — the schtasks path. Everything here is
 * hermetic: the schtasks runner is injected (the real `schtasks` never
 * runs), and the two file/string renderers are pure. We assert the exact
 * schtasks argv and the launcher-body / /TR construction, not Task
 * Scheduler's behaviour.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  SCHTASKS_TASK_NAME,
  renderSchtasksTr,
  renderWinDaemonScript,
  schtasksTaskScriptPath,
  runWinInstall,
  runWinUninstall,
  runWinStart,
  runWinRestart,
  runWinStop,
  type SchtasksFn,
} from "../commands/daemon.js"

afterEach(() => {
  vi.restoreAllMocks()
})

/** Each test gets its own throwaway HOME so no real launcher file is ever
 *  written to the developer's `~/.agentproto`. */
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "agentproto-daemon-win-"))
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  return { chunks, restore: () => spy.mockRestore() }
}

describe("renderSchtasksTr", () => {
  it("double-quotes the launcher path", () => {
    expect(renderSchtasksTr("C:\\Users\\u\\.agentproto\\agentproto-daemon.cmd")).toBe(
      '"C:\\Users\\u\\.agentproto\\agentproto-daemon.cmd"',
    )
  })
})

describe("renderWinDaemonScript", () => {
  it("quotes args with spaces and redirects stdout+stderr into daemon.log", () => {
    const body = renderWinDaemonScript(
      ["C:\\Program Files\\node.exe", "C:\\cli.mjs", "serve", "--port", "18790"],
      "C:\\Users\\u\\.agentproto\\daemon.log",
    )
    expect(body).toBe(
      '@echo off\n"C:\\Program Files\\node.exe" C:\\cli.mjs serve --port 18790 >> "C:\\Users\\u\\.agentproto\\daemon.log" 2>&1\n',
    )
  })

  it("doubles embedded quotes so cmd keeps them literal", () => {
    expect(renderWinDaemonScript(["--allow-origin", 'a "b"'], "log")).toContain('--allow-origin ')
    expect(renderWinDaemonScript(["--allow-origin", 'a "b"'], "log")).toContain('"a ""b"""')
  })
})

describe("runWinInstall", () => {
  it("creates a per-user ONLOGON task naming the launcher, then starts it", async () => {
    const home = tempHome()
    try {
    const calls: string[][] = []
    const fakeRuns: SchtasksFn = async args => {
      calls.push(args)
      return { code: 0, stdout: "SUCCESS", stderr: "" }
    }
    const out = captureStdout()
    const code = await runWinInstall([], fakeRuns, home)
    out.restore()

    expect(code).toBe(0)
    expect(calls).toHaveLength(2)
    const first = calls[0]
    if (!first) throw new Error("no create call recorded")
    const esc = (i: number): string => {
      const v = first[i]
      expect(v).toBeDefined()
      return v as string
    }
    expect(esc(0)).toBe("/Create")
    expect(first).toContain("/TN")
    const tnIdx = first.indexOf("/TN")
    expect(esc(tnIdx + 1)).toBe(SCHTASKS_TASK_NAME)
    expect(first).toContain("/SC")
    expect(esc(first.indexOf("/SC") + 1)).toBe("ONLOGON")
    expect(first).toContain("/F")
    // /TR names the generated launcher, quoted.
    const tr = esc(first.indexOf("/TR") + 1)
    expect(tr).toBe(`"${schtasksTaskScriptPath(home)}"`)
    expect(tr).toContain("agentproto-daemon.cmd")
    expect(calls[1]).toEqual(["/Run", "/TN", SCHTASKS_TASK_NAME])
    expect(out.chunks.join("")).toContain("scheduled task")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("a schtasks create failure is a failed install (exit code, no /Run)", async () => {
    const home = tempHome()
    try {
      const calls: string[][] = []
      const fake: SchtasksFn = async args => {
        calls.push(args)
        return { code: 1, stdout: "", stderr: "ERROR: boom" }
      }
      const code = await runWinInstall([], fake, home)
      expect(code).toBe(1)
      // Only the create ran — a failed install never starts the task.
      expect(calls).toHaveLength(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("--dry-run prints the command without calling schtasks", async () => {
    const home = tempHome()
    try {
      let invoked = false
      const fake: SchtasksFn = async () => {
        invoked = true
        return { code: 0, stdout: "", stderr: "" }
      }
      const out = captureStdout()
      const code = await runWinInstall(["--dry-run"], fake, home)
      out.restore()

      expect(code).toBe(0)
      expect(invoked).toBe(false)
      expect(out.chunks.join("")).toContain(schtasksTaskScriptPath(home))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("runWinUninstall / start / restart / stop", () => {
  it("uninstall ends the task then deletes with /F; already-absent is idempotent", async () => {
    const calls: string[][] = []
    let failDelete = false
    const fake: SchtasksFn = async args => {
      calls.push(args)
      if (failDelete) return { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }
      return { code: 0, stdout: "deleted", stderr: "" }
    }
    let out = captureStdout()
    expect(await runWinUninstall(fake)).toBe(0)
    out.restore()
    expect(calls).toEqual([["/End", "/TN", SCHTASKS_TASK_NAME], ["/Delete", "/TN", SCHTASKS_TASK_NAME, "/F"]])

    calls.length = 0
    failDelete = true
    out = captureStdout()
    expect(await runWinUninstall(fake)).toBe(0)
    out.restore()
    expect(out.chunks.join("")).toContain("already absent")
  })

  it("start runs the task once and reports health", async () => {
    const calls: string[][] = []
    const fake: SchtasksFn = async args => {
      calls.push(args)
      return { code: 0, stdout: "", stderr: "" }
    }
    const out = captureStdout()
    const code = await runWinStart(fake, async () => ({
      url: "http://127.0.0.1:18790",
      version: "0.31.0",
      pid: 1234,
    }), 1)
    out.restore()
    expect(code).toBe(0)
    expect(calls).toEqual([["/Run", "/TN", SCHTASKS_TASK_NAME]])
    expect(out.chunks.join("")).toContain("started")
  })

  it("restart = End + Run", async () => {
    const calls: string[][] = []
    const fake: SchtasksFn = async args => {
      calls.push(args)
      return { code: 0, stdout: "", stderr: "" }
    }
    await runWinRestart(fake, async () => null, 1)
    expect(calls).toEqual([
      ["/End", "/TN", SCHTASKS_TASK_NAME],
      ["/Run", "/TN", SCHTASKS_TASK_NAME],
    ])
  })

  it("stop ends the task, failing when /End does", async () => {
    const fake: SchtasksFn = async () => ({ code: 0, stdout: "", stderr: "" })
    expect(await runWinStop(fake)).toBe(0)
    expect(await runWinStop(async () => ({ code: 1, stdout: "", stderr: "not yet running" }))).toBe(1)
  })

  it("start surfaces the schtasks failure code", async () => {
    const code = await runWinStart(async () => ({ code: 1, stdout: "", stderr: "ERROR: not found" }), async () => null, 1)
    expect(code).toBe(1)
  })
})
