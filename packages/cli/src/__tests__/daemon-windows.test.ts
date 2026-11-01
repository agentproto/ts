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
  winDaemonInstallCommand,
  winDaemonShimCommand,
  winExecutionPolicyBlocksScripts,
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

function captureStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  return { chunks, restore: () => spy.mockRestore() }
}

describe("winDaemonInstallCommand", () => {
  it("cites the .cmd shim when a Restricted/AllSigned policy blocks the .ps1 shim", () => {
    expect(winExecutionPolicyBlocksScripts("Restricted")).toBe(true)
    expect(winExecutionPolicyBlocksScripts("AllSigned\n")).toBe(true)
    expect(winExecutionPolicyBlocksScripts("RemoteSigned")).toBe(false)
    expect(winExecutionPolicyBlocksScripts("Bypass")).toBe(false)
    expect(winExecutionPolicyBlocksScripts(null)).toBe(false)
    expect(winDaemonInstallCommand("Restricted")).toBe("agentproto.cmd daemon install")
    expect(winDaemonInstallCommand("AllSigned")).toBe("agentproto.cmd daemon install")
    expect(winDaemonInstallCommand("RemoteSigned")).toBe("agentproto daemon install")
    expect(winDaemonInstallCommand(null)).toBe("agentproto daemon install")
  })

  it("rewrites start and restart hints too, not just install", () => {
    expect(winDaemonShimCommand("agentproto daemon start", "Restricted")).toBe("agentproto.cmd daemon start")
    expect(winDaemonShimCommand("agentproto daemon restart", "AllSigned")).toBe("agentproto.cmd daemon restart")
    expect(winDaemonShimCommand("agentproto daemon start", "RemoteSigned")).toBe("agentproto daemon start")
  })
})

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
      '@echo off\nchcp 65001 > nul\ncd /d "%USERPROFILE%"\n"C:\\Program Files\\node.exe" C:\\cli.mjs serve --port 18790 >> "C:\\Users\\u\\.agentproto\\daemon.log" 2>&1\n',
    )
  })

  it("switches the console to UTF-8 before any non-ASCII path so cmd reads the file back as written (accents in the user profile)", () => {
    const acct = "C:\\Users\\MathildeDugué\\.agentproto\\daemon.log"
    const body = renderWinDaemonScript(
      ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\MathildeDugué\\cli.mjs", "serve"],
      acct,
      "C:\\Users\\MathildeDugué\\work",
    )
    const lines = body.split("\n")
    expect(lines[0]).toBe("@echo off")
    // chcp must precede every line carrying a non-ASCII path.
    expect(lines[1]).toBe("chcp 65001 > nul")
    expect(lines[2]).toBe('cd /d "C:\\Users\\MathildeDugué\\work"')
    expect(body).toContain("MathildeDugué\\cli.mjs")
    expect(body).toContain(`>> "${acct}" 2>&1`)
  })

  it("doubles embedded quotes so cmd keeps them literal", () => {
    expect(renderWinDaemonScript(["--allow-origin", 'a "b"'], "log")).toContain('--allow-origin ')
    expect(renderWinDaemonScript(["--allow-origin", 'a "b"'], "log")).toContain('"a ""b"""')
  })

  it("starts with a cd /d so the daemon never runs from C:\\Windows\\System32 (WIN11 field test 2026-09-30: System32 runtime.json EPERM)", () => {
    const noWorkspace = renderWinDaemonScript(["node", "cli.mjs", "serve"], "log")
    expect(noWorkspace.split("\n")[2]).toBe('cd /d "%USERPROFILE%"')

    const withWorkspace = renderWinDaemonScript(["node", "cli.mjs", "serve"], "log", "C:\\ws\\mine")
    expect(withWorkspace.split("\n")[2]).toBe('cd /d "C:\\ws\\mine"')

    const quoted = renderWinDaemonScript(["node", "cli.mjs", "serve"], "log", 'C:\\a "b"')
    expect(quoted.split("\n")[2]).toBe('cd /d "C:\\a ""b"""')
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

  it("reports the captured node/entry/source so a local-folder install is visible", async () => {
    const home = tempHome()
    try {
      const fake: SchtasksFn = async () => ({ code: 0, stdout: "", stderr: "" })
      const out = captureStdout()
      const code = await runWinInstall([], fake, home)
      out.restore()

      expect(code).toBe(0)
      const text = out.chunks.join("")
      expect(text).toContain("service will run:")
      expect(text).toContain("node:")
      expect(text).toContain("source:")
      // This test runs under vitest (a node_modules entry) ⇒ published, so
      // the local-folder warning must NOT fire.
      expect(text).toContain("published npm install")
      expect(text).not.toContain("LOCAL FOLDER")
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
  it("uninstall queries first, then ends and deletes with /F; already-absent is idempotent", async () => {
    const calls: string[][] = []
    let present = true
    const fake: SchtasksFn = async args => {
      calls.push(args)
      if (args[0] === "/Query" && !present) return { code: 1, stdout: "", stderr: "not found" }
      return { code: 0, stdout: "deleted", stderr: "" }
    }
    let out = captureStdout()
    expect(await runWinUninstall(fake)).toBe(0)
    out.restore()
    expect(calls).toEqual([
      ["/Query", "/TN", SCHTASKS_TASK_NAME],
      ["/End", "/TN", SCHTASKS_TASK_NAME],
      ["/Delete", "/TN", SCHTASKS_TASK_NAME, "/F"],
    ])

    calls.length = 0
    present = false
    out = captureStdout()
    expect(await runWinUninstall(fake)).toBe(0)
    out.restore()
    expect(calls).toEqual([["/Query", "/TN", SCHTASKS_TASK_NAME]])
    expect(out.chunks.join("")).toContain("already absent")
  })

  it("already-absent is decided by /Query's exit code, not by parsing localized OEM error text", async () => {
    const calls: string[][] = []
    const fake: SchtasksFn = async args => {
      calls.push(args)
      // French Windows message in the OEM code page, decoded as UTF-8: it is
      // mojibake and carries none of the old English phrases. Text-matching
      // used to report this harmless state as a hard failure.
      return { code: 1, stdout: "", stderr: "ERREUR: Le syst?me ne peut pas trouver le fichier sp?cifi?.\n" }
    }
    const out = captureStdout()
    expect(await runWinUninstall(fake)).toBe(0)
    out.restore()
    expect(calls.map(c => c[0])).toEqual(["/Query"])
    expect(out.chunks.join("")).toContain("already absent")
  })

  it("uninstall still fails when /Delete fails but /Query confirms the task exists", async () => {
    const fake: SchtasksFn = async args => {
      if (args[0] === "/Query") return { code: 0, stdout: "TaskName: agentproto-daemon\n", stderr: "" }
      return { code: 1, stdout: "", stderr: "denied" }
    }
    const err = captureStderr()
    expect(await runWinUninstall(fake)).toBe(1)
    err.restore()
    expect(err.chunks.join("")).toContain("schtasks delete failed")
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
    // Explicit dead-port health stubs: the default deps would probe a REAL
    // daemon port, and these tests must stay hermetic.
    expect(await runWinStop(fake, { health: async () => null })).toBe(0)
    expect(await runWinStop(async () => ({ code: 1, stdout: "", stderr: "not yet running" }))).toBe(1)
  })

  it("stop with a dead port right after /End writes 'task ended' and never kills (healthy release)", async () => {
    const fake: SchtasksFn = async () => ({ code: 0, stdout: "", stderr: "" })
    const out = captureStdout()
    const code = await runWinStop(fake, {
      health: async () => null,
      killTree: async (pid: number) => {
        throw new Error("never called: " + pid)
      },
      readDaemonPid: async () => {
        throw new Error("never called")
      },
      releaseDelayMs: 0,
    })
    out.restore()
    expect(code).toBe(0)
    expect(out.chunks.join("")).toContain("task ended")
  })

  it("a port STILL answering after /End kills the recorded pid tree and confirms the release (WIN11 field test 2026-09-30: the node child kept listening, so a later `start` reused a zombie daemon)", async () => {
    const fake: SchtasksFn = async () => ({ code: 0, stdout: "", stderr: "" })
    const killed: number[] = []
    let probes = 0
    const out = captureStdout()
    const code = await runWinStop(fake, {
      health: async () => {
        probes++
        // First probe: still alive (with the pid). Post-kill probes: dead.
        return probes === 1 ? { url: "http://127.0.0.1:18790", pid: 4242 } : null
      },
      killTree: async (pid: number) => {
        killed.push(pid)
        return 0
      },
      readDaemonPid: async () => {
        throw new Error("should not need fallback: /health exposes the pid")
      },
      releaseDelayMs: 0,
    })
    out.restore()
    expect(code).toBe(0)
    expect(killed).toEqual([4242])
    expect(out.chunks.join("")).toContain("port released")
  })

  it("when /health carries no pid the recorded runtime.json pid is used as the fallback", async () => {
    const fake: SchtasksFn = async () => ({ code: 0, stdout: "", stderr: "" })
    const killed: number[] = []
    let probes = 0
    captureStdout()
    const code = await runWinStop(fake, {
      health: async () => {
        probes++
        return probes === 1 ? { url: "http://127.0.0.1:18790" } : null
      },
      killTree: async (pid: number) => {
        killed.push(pid)
        return 0
      },
      readDaemonPid: async () => 1987,
      releaseDelayMs: 0,
    })
    expect(code).toBe(0)
    expect(killed).toEqual([1987])
  })

  it("an unkillable port (pid tree killed but still answering after 3 re-probes) is surfaced, not lied about", async () => {
    const fake: SchtasksFn = async () => ({ code: 0, stdout: "", stderr: "" })
    const killed: number[] = []
    const errChunks: string[] = []
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errChunks.push(String(chunk))
      return true
    })
    try {
      const code = await runWinStop(fake, {
        health: async () => ({ url: "http://127.0.0.1:18790", pid: 123 }),
        killTree: async (pid: number) => {
          killed.push(pid)
          return 0
        },
        readDaemonPid: async () => null,
        releaseDelayMs: 0,
      })
      expect(code).toBe(0)
      expect(killed).toEqual([123])
      expect(errChunks.join("")).toContain("port still answering")
    } finally {
      spy.mockRestore()
    }
  })

  it("start surfaces the schtasks failure code", async () => {
    const code = await runWinStart(
      async () => ({ code: 1, stdout: "", stderr: "ERROR: not found" }),
      async () => null,
      1,
      async () => "RemoteSigned",
    )
    expect(code).toBe(1)
  })

  it("start cites `agentproto.cmd daemon install` when the PowerShell policy blocks the .ps1 shim", async () => {
    const err = captureStderr()
    const code = await runWinStart(
      async () => ({ code: 1, stdout: "", stderr: "sp?cifi?\n" }),
      async () => null,
      1,
      async () => "Restricted",
    )
    err.restore()
    expect(code).toBe(1)
    const text = err.chunks.join("")
    expect(text).toContain("agentproto.cmd daemon install")
    // Never echo the OEM-codepage schtasks text back as mojibake.
    expect(text).not.toContain("sp?cifi?")
  })

  it("start keeps the plain command when the policy allows scripts", async () => {
    const err = captureStderr()
    await runWinStart(
      async () => ({ code: 1, stdout: "", stderr: "" }),
      async () => null,
      1,
      async () => "RemoteSigned",
    )
    err.restore()
    expect(err.chunks.join("")).toContain("Run `agentproto daemon install` first.")
  })

  it("restart cites the .cmd shim under a blocking policy too", async () => {
    const err = captureStderr()
    const code = await runWinRestart(
      async args => (args[0] === "/Run" ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" }),
      async () => null,
      1,
      async () => "AllSigned",
    )
    err.restore()
    expect(code).toBe(1)
    expect(err.chunks.join("")).toContain("agentproto.cmd daemon install")
  })
})
