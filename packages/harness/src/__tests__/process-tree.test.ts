import { describe, it, expect, afterEach } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { descendantsOf, terminateChildTree } from "../process-tree.js"

const isWindows = process.platform === "win32"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function waitGone(pids: number[], ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (pids.some(alive) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25))
  }
}

// A wrapper that ignores SIGTERM (like the npx/npm-exec wrapper observed
// live) and spawns a grandchild that ignores it too — the adapter stand-in.
// The grandchild prints its own pid on the shared stdout only AFTER its
// handler is installed — otherwise a loaded machine can deliver SIGTERM
// before node has booted far enough to ignore it.
const WRAPPER = `
process.on("SIGTERM", () => {})
const { spawn } = require("node:child_process")
spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log(String(process.pid)); setInterval(() => {}, 1000)'], { stdio: ["ignore", "inherit", "ignore"] })
setInterval(() => {}, 1000)
`

const spawned: number[] = []

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // gone — the expected case
    }
  }
})

async function startWrapper(): Promise<{ child: ChildProcess; grandchild: number }> {
  const child = spawn(process.execPath, ["-e", WRAPPER], { stdio: ["ignore", "pipe", "inherit"] })
  spawned.push(child.pid as number)
  const rl = createInterface({ input: child.stdout! })
  const line = await new Promise<string>(resolve => rl.once("line", resolve))
  rl.close()
  const grandchild = Number(line.trim())
  spawned.push(grandchild)
  return { child, grandchild }
}

describe("descendantsOf", () => {
  it("walks the whole subtree breadth-first and nothing outside it", () => {
    const rows = [
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 },
      { pid: 13, ppid: 10 },
      { pid: 20, ppid: 1 },
      { pid: 21, ppid: 20 },
    ]
    expect(descendantsOf(10, rows)).toEqual([11, 13, 12])
    expect(descendantsOf(20, rows)).toEqual([21])
    expect(descendantsOf(12, rows)).toEqual([])
  })

  it("survives a ppid cycle", () => {
    expect(descendantsOf(1, [{ pid: 2, ppid: 1 }, { pid: 1, ppid: 2 }])).toEqual([2])
  })
})

describe.skipIf(isWindows)("terminateChildTree", () => {
  it("leaves no descendant alive when the wrapper and the adapter both ignore SIGTERM", async () => {
    const { child, grandchild } = await startWrapper()
    const root = child.pid as number
    expect(alive(root)).toBe(true)
    expect(alive(grandchild)).toBe(true)

    const res = await terminateChildTree(child, { graceMs: 300 })

    expect(res.descendants).toContain(grandchild)
    expect(res.killed).toEqual(expect.arrayContaining([root, grandchild]))
    await waitGone([root, grandchild])
    expect(alive(root)).toBe(false)
    expect(alive(grandchild)).toBe(false)
  })

  it("reaches descendants even after the wrapper itself has exited on SIGTERM", async () => {
    // Wrapper exits on SIGTERM (default disposition); the adapter under it
    // ignores SIGTERM and would otherwise reparent to init and leak.
    const script = WRAPPER.replace('process.on("SIGTERM", () => {})', "")
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] })
    spawned.push(child.pid as number)
    const rl = createInterface({ input: child.stdout! })
    const grandchild = Number((await new Promise<string>(r => rl.once("line", r))).trim())
    rl.close()
    spawned.push(grandchild)

    const res = await terminateChildTree(child, { graceMs: 300 })

    expect(res.killed).toContain(grandchild)
    await waitGone([grandchild])
    expect(alive(grandchild)).toBe(false)
  })

  it("finishes early without SIGKILL when the tree honours SIGTERM", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    spawned.push(child.pid as number)
    await new Promise(r => child.once("spawn", r))
    const started = Date.now()
    const res = await terminateChildTree(child, { graceMs: 5000 })
    expect(res.killed).toEqual([])
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it("is a no-op for a child that already exited", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
    await new Promise(r => child.once("exit", r))
    let listed = false
    const res = await terminateChildTree(child, {
      listProcesses: async () => {
        listed = true
        return []
      },
    })
    expect(res).toEqual({ descendants: [], killed: [] })
    expect(listed).toBe(false)
  })
})
