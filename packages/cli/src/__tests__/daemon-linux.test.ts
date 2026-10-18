/**
 * `agentproto daemon` on Linux — the systemd --user path and its
 * detached-serve pidfile fallback. Everything here is hermetic: the
 * systemctl/loginctl runners, the detached-spawn, the pid alive-probe and
 * the health probe are all injected (no real systemd, pidfile, or network
 * is ever touched), and the unit renderers are pure. We assert the exact
 * systemctl argv and the unit-file construction, not systemd's behaviour.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  SYSTEMD_UNIT_NAME,
  detectLinuxDaemonMode,
  detectSystemdLinger,
  extractUnitPathValue,
  linuxPidfilePath,
  refreshUnitPathIfNeeded,
  renderLingerNote,
  renderSystemdUnit,
  runLinuxInstall,
  runLinuxRestart,
  runLinuxStart,
  runLinuxStatus,
  runLinuxStop,
  runLinuxUninstall,
  systemdQuote,
  systemdUnitPath,
  type DaemonHealthInfo,
  type ExecCmdResult,
  type LinuxExecFn,
  type SystemdFn,
} from "../commands/daemon.js"

afterEach(() => {
  vi.restoreAllMocks()
})

/** Each test gets its own throwaway HOME so no real unit/pidfile/log is
 *  ever written under the developer's home. */
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "agentproto-daemon-linux-"))
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

const OK: ExecCmdResult = { code: 0, stdout: "", stderr: "" }

/** A full user session: `systemctl --user` answers, lingering probe benign. */
function sessionExec(opts: { linger?: ExecCmdResult } = {}): LinuxExecFn {
  return async (cmd, args) => {
    if (cmd === "systemctl" && args[0] === "--user" && args[1] === "show-environment") return OK
    if (cmd === "loginctl") return opts.linger ?? OK
    return { code: 1, stdout: "", stderr: "" }
  }
}

/** No systemd user session (container / minimal VM / E2B box). */
const noSessionExec: LinuxExecFn = async (cmd, args) => {
  if (cmd === "systemctl") return { code: 1, stdout: "", stderr: "Failed to connect to bus: No such file or directory" }
  return { code: 1, stdout: "", stderr: "" }
}

describe("renderSystemdUnit", () => {
  const unit = renderSystemdUnit({
    fullArgv: ["/usr/bin/node", "/opt/agentproto/cli.mjs", "serve", "--port", "18790"],
    logPath: "/home/u/.agentproto/daemon.log",
    path: "/usr/local/bin:/usr/bin:/bin",
    home: "/home/u",
    workingDir: "/work/space",
  })

  it("ExecStart is the node + cli.mjs + serve argv", () => {
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/agentproto/cli.mjs serve --port 18790")
  })

  it("captures PATH and HOME as Environment= lines", () => {
    expect(unit).toContain("Environment=PATH=/usr/local/bin:/usr/bin:/bin")
    expect(unit).toContain("Environment=HOME=/home/u")
  })

  it("appends both stdout and stderr to the shared daemon.log", () => {
    expect(unit).toContain("StandardOutput=append:/home/u/.agentproto/daemon.log")
    expect(unit).toContain("StandardError=append:/home/u/.agentproto/daemon.log")
  })

  it("is crash-only (Restart=on-failure), mirroring the plist's SuccessfulExit=false", () => {
    expect(unit).toContain("Restart=on-failure")
    expect(unit).not.toContain("Restart=always")
  })

  it("sets WorkingDirectory and WantedBy=default.target", () => {
    expect(unit).toContain("WorkingDirectory=/work/space")
    expect(unit).toContain("WantedBy=default.target")
  })
})

describe("systemdQuote", () => {
  it("leaves simple words bare", () => {
    expect(systemdQuote("serve")).toBe("serve")
    expect(systemdQuote("/usr/bin/node")).toBe("/usr/bin/node")
  })

  it("double-quotes words with spaces, escaping \\ \" and doubling %", () => {
    expect(systemdQuote("/opt/My Tools/node")).toBe('"/opt/My Tools/node"')
    expect(systemdQuote('a"b')).toBe('"a\\"b"')
    expect(systemdQuote("100%")).toBe('"100%%"')
  })
})

describe("extractUnitPathValue", () => {
  it("round-trips the PATH out of a rendered unit", () => {
    const unit = renderSystemdUnit({
      fullArgv: ["node", "cli.mjs", "serve"],
      logPath: "log",
      path: "/a:/b",
      home: "/home/u",
    })
    expect(extractUnitPathValue(unit)).toBe("/a:/b")
  })

  it("null when the unit has no PATH", () => {
    expect(extractUnitPathValue("[Unit]\nDescription=x\n")).toBeNull()
  })
})

describe("refreshUnitPathIfNeeded", () => {
  const base = {
    unitPath: "/tmp/u/agentproto.service",
    fullArgv: ["node", "cli.mjs", "serve"],
    logPath: "/tmp/u/daemon.log",
    home: "/tmp/u",
    freshPath: "/fresh:/bin",
  }

  it("rewrites + daemon-reloads only when the PATH changed", async () => {
    const current = renderSystemdUnit({
      fullArgv: base.fullArgv,
      logPath: base.logPath,
      path: "/stale:/bin",
      home: base.home,
    })
    const written: string[] = []
    const runs: string[][] = []
    const rewrote = await refreshUnitPathIfNeeded({
      ...base,
      currentUnit: current,
      run: async args => {
        runs.push([...args])
        return OK
      },
      writeFile: async (_path, data) => {
        written.push(data)
      },
    })
    expect(rewrote).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0]).toContain("Environment=PATH=/fresh:/bin")
    expect(runs).toEqual([["daemon-reload"]])
  })

  it("no rewrite when unchanged, and never for a missing unit", async () => {
    const same = renderSystemdUnit({
      fullArgv: base.fullArgv,
      logPath: base.logPath,
      path: base.freshPath,
      home: base.home,
    })
    const run = vi.fn(async () => OK)
    expect(
      await refreshUnitPathIfNeeded({ ...base, currentUnit: same, run, writeFile: async () => {} }),
    ).toBe(false)
    expect(
      await refreshUnitPathIfNeeded({ ...base, currentUnit: null, run, writeFile: async () => {} }),
    ).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})

describe("detectLinuxDaemonMode / detectSystemdLinger", () => {
  it("systemctl --user show-environment exit 0 ⇒ systemd", async () => {
    expect(await detectLinuxDaemonMode(sessionExec())).toBe("systemd")
  })

  it("a non-connecting user manager (containers, minimal VMs, E2B) ⇒ pidfile", async () => {
    expect(await detectLinuxDaemonMode(noSessionExec)).toBe("pidfile")
  })

  it("a missing systemctl binary (code 127) ⇒ pidfile", async () => {
    expect(await detectLinuxDaemonMode(async () => ({ code: 127, stdout: "", stderr: "spawn systemctl ENOENT" }))).toBe("pidfile")
  })

  it("a rejecting exec double ⇒ pidfile, never a crash", async () => {
    expect(
      await detectLinuxDaemonMode(async () => {
        throw new Error("boom")
      }),
    ).toBe("pidfile")
  })

  it("parses Linger=yes/no and treats a failed probe as unknown", async () => {
    expect(await detectSystemdLinger(async () => ({ code: 0, stdout: "Linger=yes\n", stderr: "" }), "u")).toBe(true)
    expect(await detectSystemdLinger(async () => ({ code: 0, stdout: "Linger=no\n", stderr: "" }), "u")).toBe(false)
    expect(await detectSystemdLinger(async () => ({ code: 1, stdout: "", stderr: "no user" }), "u")).toBeNull()
  })

  it("renderLingerNote speaks only when lingering is OFF", () => {
    expect(renderLingerNote(false)).toContain("loginctl enable-linger")
    expect(renderLingerNote(true)).toBe("")
    expect(renderLingerNote(null)).toBe("")
  })
})

describe("runLinuxInstall", () => {
  it("--dry-run prints the unit and the systemctl commands, touches nothing", async () => {
    const home = tempHome()
    try {
      const calls: string[][] = []
      const systemctl: SystemdFn = async args => {
        calls.push([...args])
        return OK
      }
      const out = captureStdout()
      const code = await runLinuxInstall(["--dry-run"], { home, systemctl, exec: sessionExec() })
      out.restore()

      expect(code).toBe(0)
      expect(calls).toEqual([])
      const text = out.chunks.join("")
      expect(text).toContain(systemdUnitPath(home))
      expect(text).toContain(`ExecStart=`)
      expect(text).toContain(`# systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`)
      // Nothing was written under the throwaway HOME.
      const { existsSync } = await import("node:fs")
      expect(existsSync(systemdUnitPath(home))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("systemd mode: writes the unit, daemon-reloads, enable --now", async () => {
    const home = tempHome()
    try {
      const calls: string[][] = []
      const systemctl: SystemdFn = async args => {
        calls.push([...args])
        return OK
      }
      const out = captureStdout()
      const code = await runLinuxInstall([], { home, systemctl, exec: sessionExec() })
      out.restore()

      expect(code).toBe(0)
      expect(calls).toEqual([["daemon-reload"], ["enable", "--now", SYSTEMD_UNIT_NAME]])
      const { readFileSync, existsSync } = await import("node:fs")
      expect(existsSync(systemdUnitPath(home))).toBe(true)
      const unit = readFileSync(systemdUnitPath(home), "utf8")
      expect(unit).toContain("ExecStart=")
      expect(unit).toContain("serve")
      expect(out.chunks.join("")).toContain(`wrote ${systemdUnitPath(home)}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("flags lingering=off after a successful install (never enables it itself)", async () => {
    const home = tempHome()
    try {
      const exec = sessionExec({ linger: { code: 0, stdout: "Linger=no\n", stderr: "" } })
      const out = captureStdout()
      const code = await runLinuxInstall([], {
        home,
        systemctl: async () => OK,
        exec,
      })
      out.restore()
      expect(code).toBe(0)
      expect(out.chunks.join("")).toContain("loginctl enable-linger")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("a failed enable --now is a failed install (exit code)", async () => {
    const home = tempHome()
    try {
      const err = captureStderr()
      const code = await runLinuxInstall([], {
        home,
        exec: sessionExec(),
        systemctl: async args => (args[0] === "enable" ? { code: 1, stdout: "", stderr: "Failed to enable unit" } : OK),
      })
      err.restore()
      expect(code).toBe(1)
      expect(err.chunks.join("")).toContain("enable --now failed")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("no systemd user session ⇒ detached pidfile fallback (no unit written)", async () => {
    const home = tempHome()
    try {
      let spawned: { fullArgv: string[] } | null = null
      const out = captureStdout()
      const code = await runLinuxInstall([], {
        home,
        exec: noSessionExec,
        health: async () => ({ url: "http://127.0.0.1:18790", version: "0.31.0", pid: 4242 }),
        spawnServe: async opts => {
          spawned = opts
          return 4242
        },
      })
      out.restore()

      expect(code).toBe(0)
      expect(spawned).not.toBeNull()
      const { readFileSync, existsSync } = await import("node:fs")
      expect(existsSync(systemdUnitPath(home))).toBe(false)
      expect(readFileSync(linuxPidfilePath(home), "utf8").trim()).toBe("4242")
      expect(out.chunks.join("")).toContain("detached serve")
      expect(out.chunks.join("")).toContain(linuxPidfilePath(home))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("runLinuxUninstall", () => {
  it("systemd mode: disable --now, delete the unit, daemon-reload", async () => {
    const home = tempHome()
    try {
      const { writeFileSync, existsSync } = await import("node:fs")
      const { mkdirSync } = await import("node:fs")
      mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true })
      writeFileSync(systemdUnitPath(home), "[Unit]\n", "utf8")

      const calls: string[][] = []
      const systemctl: SystemdFn = async args => {
        calls.push([...args])
        return OK
      }
      const out = captureStdout()
      const code = await runLinuxUninstall({ home, systemctl, exec: sessionExec() })
      out.restore()

      expect(code).toBe(0)
      expect(calls).toEqual([
        ["disable", "--now", SYSTEMD_UNIT_NAME],
        ["daemon-reload"],
      ])
      expect(existsSync(systemdUnitPath(home))).toBe(false)
      expect(out.chunks.join("")).toContain("removed")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("is idempotent when nothing is installed", async () => {
    const home = tempHome()
    try {
      const out = captureStdout()
      const code = await runLinuxUninstall({
        home,
        exec: sessionExec(),
        systemctl: async () => ({ code: 1, stdout: "", stderr: "Unit agentproto.service not loaded." }),
      })
      out.restore()
      expect(code).toBe(0)
      expect(out.chunks.join("")).toContain("already absent")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("clears a leftover pidfile daemon (fallback mode)", async () => {
    const home = tempHome()
    try {
      const { writeFileSync } = await import("node:fs")
      const { mkdirSync } = await import("node:fs")
      mkdirSync(join(home, ".agentproto"), { recursive: true })
      writeFileSync(linuxPidfilePath(home), "4242\n", "utf8")

      const killed: Array<[number, string]> = []
      let alive = true
      const out = captureStdout()
      const code = await runLinuxUninstall({
        home,
        exec: noSessionExec,
        kill: (pid, signal) => {
          killed.push([pid, signal])
          alive = false
        },
        isAlive: () => alive,
      })
      out.restore()

      expect(code).toBe(0)
      expect(killed).toEqual([[4242, "SIGTERM"]])
      const { existsSync } = await import("node:fs")
      expect(existsSync(linuxPidfilePath(home))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("runLinuxStart / restart / stop (systemd mode)", () => {
  it("start runs `systemctl --user start` and reports started", async () => {
    const home = tempHome()
    try {
      const calls: string[][] = []
      const systemctl: SystemdFn = async args => {
        calls.push([...args])
        return OK
      }
      const health: DaemonHealthInfo = { url: "http://127.0.0.1:18790", version: "0.31.0", pid: 1234 }
      const out = captureStdout()
      const code = await runLinuxStart(
        { home, systemctl, exec: sessionExec(), health: async () => health },
        1,
      )
      out.restore()
      expect(code).toBe(0)
      expect(calls).toEqual([["start", SYSTEMD_UNIT_NAME]])
      expect(out.chunks.join("")).toContain("started")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("start surfaces the systemctl failure with an install hint", async () => {
    const home = tempHome()
    try {
      const err = captureStderr()
      const code = await runLinuxStart(
        {
          home,
          exec: sessionExec(),
          systemctl: async () => ({ code: 5, stdout: "", stderr: "Unit agentproto.service not found." }),
        },
        1,
      )
      err.restore()
      expect(code).toBe(5)
      expect(err.chunks.join("")).toContain("daemon install")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("restart runs `systemctl --user restart` and reports restarted", async () => {
    const home = tempHome()
    try {
      const calls: string[][] = []
      const systemctl: SystemdFn = async args => {
        calls.push([...args])
        return OK
      }
      const out = captureStdout()
      const code = await runLinuxRestart(
        { home, systemctl, exec: sessionExec(), health: async () => null },
        1,
        0,
        0,
      )
      out.restore()
      expect(code).toBe(0)
      expect(calls).toEqual([["restart", SYSTEMD_UNIT_NAME]])
      expect(out.chunks.join("")).toContain("restarted")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("stop runs `systemctl --user stop`", async () => {
    const home = tempHome()
    try {
      const calls: string[][] = []
      const systemctl: SystemdFn = async args => {
        calls.push([...args])
        return OK
      }
      const out = captureStdout()
      const code = await runLinuxStop(
        { home, systemctl, exec: sessionExec() },
        async () => null,
      )
      out.restore()
      expect(code).toBe(0)
      expect(calls).toEqual([["stop", SYSTEMD_UNIT_NAME]])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("runLinuxStart / restart / stop (pidfile fallback)", () => {
  it("start spawns a detached serve and records its pid", async () => {
    const home = tempHome()
    try {
      let spawned: { fullArgv: string[]; cwd: string; logPath: string } | null = null
      const out = captureStdout()
      const code = await runLinuxStart(
        {
          home,
          exec: noSessionExec,
          spawnServe: async opts => {
            spawned = opts
            return 777
          },
          health: async () => null,
        },
        1,
      )
      out.restore()
      expect(code).toBe(0)
      expect(spawned).not.toBeNull()
      expect(spawned!.fullArgv).toContain("serve")
      const { readFileSync } = await import("node:fs")
      expect(readFileSync(linuxPidfilePath(home), "utf8").trim()).toBe("777")
      expect(out.chunks.join("")).toContain("started")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("start is idempotent: a live recorded pid is left alone, never killed", async () => {
    const home = tempHome()
    try {
      const { writeFileSync, mkdirSync } = await import("node:fs")
      mkdirSync(join(home, ".agentproto"), { recursive: true })
      writeFileSync(linuxPidfilePath(home), "555\n", "utf8")
      let spawned = false
      const out = captureStdout()
      const code = await runLinuxStart(
        {
          home,
          exec: noSessionExec,
          spawnServe: async () => {
            spawned = true
            return 999
          },
          isAlive: () => true,
          health: async () => null,
        },
        1,
      )
      out.restore()
      expect(code).toBe(0)
      expect(spawned).toBe(false)
      expect(out.chunks.join("")).toContain("already running (pid 555")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("restart stops the old pid then spawns a fresh one", async () => {
    const home = tempHome()
    try {
      const { writeFileSync, mkdirSync, readFileSync } = await import("node:fs")
      mkdirSync(join(home, ".agentproto"), { recursive: true })
      writeFileSync(linuxPidfilePath(home), "555\n", "utf8")
      let alive = true
      const killed: number[] = []
      const spawnedPids: number[] = []
      let nextPid = 900
      const out = captureStdout()
      const code = await runLinuxRestart(
        {
          home,
          exec: noSessionExec,
          kill: pid => {
            killed.push(pid)
            alive = false
          },
          isAlive: () => alive,
          spawnServe: async () => {
            const pid = nextPid++
            spawnedPids.push(pid)
            alive = true
            return pid
          },
          health: async () => null,
        },
        1,
        0,
        0,
      )
      out.restore()
      expect(code).toBe(0)
      expect(killed).toEqual([555])
      expect(spawnedPids).toEqual([900])
      expect(readFileSync(linuxPidfilePath(home), "utf8").trim()).toBe("900")
      expect(out.chunks.join("")).toContain("restarted")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("stop SIGTERMs the pid and clears the pidfile; no pidfile is not an error", async () => {
    const home = tempHome()
    try {
      const { writeFileSync, mkdirSync, existsSync } = await import("node:fs")
      mkdirSync(join(home, ".agentproto"), { recursive: true })
      writeFileSync(linuxPidfilePath(home), "555\n", "utf8")
      let alive = true
      const killed: Array<[number, string]> = []
      const out = captureStdout()
      const code = await runLinuxStop(
        {
          home,
          exec: noSessionExec,
          kill: (pid, signal) => {
            killed.push([pid, signal])
            alive = false
          },
          isAlive: () => alive,
        },
        async () => null,
      )
      out.restore()
      expect(code).toBe(0)
      expect(killed).toEqual([[555, "SIGTERM"]])
      expect(existsSync(linuxPidfilePath(home))).toBe(false)

      // And again with nothing recorded — still 0, still no signal.
      const out2 = captureStdout()
      const code2 = await runLinuxStop(
        { home, exec: noSessionExec, kill: () => { throw new Error("never") }, isAlive: () => false },
        async () => null,
      )
      out2.restore()
      expect(code2).toBe(0)
      expect(out2.chunks.join("")).toContain("no detached daemon recorded")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("runLinuxStatus", () => {
  const probe = async () => ({ health: "ok · v0.31.0 · workspace=? · up 2s", release: "up to date" })

  it("systemd mode: names the mode, installed+active ⇒ exit 0", async () => {
    const home = tempHome()
    try {
      const systemctl: SystemdFn = async args => {
        if (args[0] === "show") {
          return {
            code: 0,
            stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\n",
            stderr: "",
          }
        }
        return OK
      }
      const out = captureStdout()
      const code = await runLinuxStatus({ home, systemctl, exec: sessionExec(), probeHealth: probe })
      out.restore()
      expect(code).toBe(0)
      const text = out.chunks.join("")
      expect(text).toContain("mode:      systemd --user")
      expect(text).toContain("unit:      installed")
      expect(text).toContain("active")
      expect(text).toContain("pid=4242")
      expect(text).toContain("/health:")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("systemd mode: lingering off is called out in status", async () => {
    const home = tempHome()
    try {
      const systemctl: SystemdFn = async args =>
        args[0] === "show"
          ? { code: 0, stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=1\n", stderr: "" }
          : OK
      const exec = sessionExec({ linger: { code: 0, stdout: "Linger=no\n", stderr: "" } })
      const out = captureStdout()
      await runLinuxStatus({ home, systemctl, exec, probeHealth: probe })
      out.restore()
      expect(out.chunks.join("")).toContain("loginctl enable-linger")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("systemd mode: unit present but inactive ⇒ exit 1 (not 2), truthful", async () => {
    const home = tempHome()
    try {
      const systemctl: SystemdFn = async args =>
        args[0] === "show"
          ? { code: 0, stdout: "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\n", stderr: "" }
          : OK
      const out = captureStdout()
      const code = await runLinuxStatus({ home, systemctl, exec: sessionExec(), probeHealth: probe })
      out.restore()
      expect(code).toBe(1)
      expect(out.chunks.join("")).toContain("inactive")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("pidfile mode: a live recorded pid ⇒ exit 0 and the mode is named", async () => {
    const home = tempHome()
    try {
      const { writeFileSync, mkdirSync } = await import("node:fs")
      mkdirSync(join(home, ".agentproto"), { recursive: true })
      writeFileSync(linuxPidfilePath(home), "4242\n", "utf8")
      const out = captureStdout()
      const code = await runLinuxStatus({
        home,
        exec: noSessionExec,
        isAlive: () => true,
        probeHealth: probe,
      })
      out.restore()
      expect(code).toBe(0)
      const text = out.chunks.join("")
      expect(text).toContain("mode:      pidfile fallback (no usable systemd user session)")
      expect(text).toContain("pidfile:   present (pid 4242)")
      expect(text).toContain("process:   running (pid 4242)")
      expect(text).not.toContain("loginctl enable-linger")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("pidfile mode: nothing running ⇒ exit 1 (never the old exit 2)", async () => {
    const home = tempHome()
    try {
      const out = captureStdout()
      const code = await runLinuxStatus({
        home,
        exec: noSessionExec,
        isAlive: () => false,
        probeHealth: probe,
      })
      out.restore()
      expect(code).toBe(1)
      const text = out.chunks.join("")
      expect(text).toContain("pidfile fallback")
      expect(text).toContain("pidfile:   absent")
      expect(text).toContain("process:   not running")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
