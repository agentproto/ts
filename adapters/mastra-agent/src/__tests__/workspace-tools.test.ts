import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeWorkspaceTools, resolveInCwd } from "../workspace-tools.js"

describe("resolveInCwd", () => {
  const cwd = "/work/space"
  it("resolves a relative path under cwd", () => {
    expect(resolveInCwd(cwd, "a/b.txt")).toBe("/work/space/a/b.txt")
  })
  it("allows the workspace root itself", () => {
    expect(resolveInCwd(cwd, ".")).toBe("/work/space")
  })
  it("rejects ../ traversal", () => {
    expect(() => resolveInCwd(cwd, "../escape")).toThrow(/escapes the workspace/)
  })
  it("rejects an absolute path outside cwd", () => {
    expect(() => resolveInCwd(cwd, "/etc/passwd")).toThrow(/escapes the workspace/)
  })
  it("allows an absolute path that IS inside cwd", () => {
    expect(resolveInCwd(cwd, "/work/space/ok.txt")).toBe("/work/space/ok.txt")
  })
})

describe("makeWorkspaceTools", () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "mastra-ws-"))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("withholds run_command when allowExec is false", () => {
    const tools = makeWorkspaceTools({ cwd: dir, allowExec: false })
    expect(tools.run_command).toBeUndefined()
    expect(tools.read_file).toBeDefined()
  })

  it("includes run_command by default", () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    expect(tools.run_command).toBeDefined()
    expect(Object.keys(tools).sort()).toEqual([
      "edit_file",
      "list_dir",
      "read_file",
      "run_command",
      "write_file",
    ])
  })

  /** Helper: grab a tool's execute as a callable, asserting it exists. */
  const exec = (tool: { execute?: unknown } | undefined) =>
    (tool!.execute as (i: unknown) => Promise<Record<string, unknown>>)

  it("write_file then read_file round-trips inside the workspace", async () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    const w = await exec(tools.write_file)({ path: "sub/hello.txt", content: "hi there" })
    expect(w).toMatchObject({ path: "sub/hello.txt" })
    const r = await exec(tools.read_file)({ path: "sub/hello.txt" })
    expect(r.content).toBe("hi there")
  })

  it("edit_file rejects a non-unique old_string", async () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    await exec(tools.write_file)({ path: "dup.txt", content: "x x" })
    await expect(
      exec(tools.edit_file)({ path: "dup.txt", old_string: "x", new_string: "y" }),
    ).rejects.toThrow(/occurs 2/)
  })

  it("read_file refuses to escape the workspace", async () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    await expect(
      exec(tools.read_file)({ path: "../../etc/hosts" }),
    ).rejects.toThrow(/escapes the workspace/)
  })
})
