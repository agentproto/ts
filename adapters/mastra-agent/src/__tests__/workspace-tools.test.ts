import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
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

  it("includes run_command and the exec-gated tools by default", () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    expect(tools.run_command).toBeDefined()
    expect(Object.keys(tools).sort()).toEqual([
      "apply_patch",
      "edit_file",
      "list_dir",
      "read_diff",
      "read_file",
      "run_command",
      "run_tests",
      "write_file",
    ])
  })

  it("withholds read_diff/apply_patch/run_tests when allowExec is false", () => {
    const tools = makeWorkspaceTools({ cwd: dir, allowExec: false })
    expect(tools.read_diff).toBeUndefined()
    expect(tools.apply_patch).toBeUndefined()
    expect(tools.run_tests).toBeUndefined()
  })

  it("merges extraTools over the built-ins, extra winning on collision", () => {
    const marker = { id: "marker" }
    const tools = makeWorkspaceTools({
      cwd: dir,
      extraTools: { read_file: marker, custom_tool: marker },
    })
    expect(tools.read_file).toBe(marker)
    expect(tools.custom_tool).toBe(marker)
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

describe("read_diff / apply_patch / run_tests (git-backed)", () => {
  let dir: string
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })

  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "mastra-ws-git-"))
    git(["init", "-q"])
    git(["config", "user.email", "test@example.com"])
    git(["config", "user.name", "Test"])
    await fs.writeFile(join(dir, "tracked.txt"), "hello\n")
    git(["add", "."])
    git(["commit", "-q", "-m", "init"])
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  afterEach(() => {
    git(["checkout", "--", "."])
    git(["clean", "-fdq"])
  })

  const exec = (tool: { execute?: unknown } | undefined) =>
    (tool!.execute as (i: unknown) => Promise<Record<string, unknown>>)

  it("read_diff shows unstaged changes against HEAD", async () => {
    await fs.writeFile(join(dir, "tracked.txt"), "hello world\n")
    const tools = makeWorkspaceTools({ cwd: dir })
    const r = await exec(tools.read_diff)({})
    expect(r.diff).toContain("tracked.txt")
    expect(r.diff).toContain("+hello world")
  })

  it("read_diff refuses a path escaping the workspace", async () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    await expect(exec(tools.read_diff)({ paths: ["../outside"] })).rejects.toThrow(
      /escapes the workspace/,
    )
  })

  it("apply_patch applies a unified diff produced by read_diff", async () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    await fs.writeFile(join(dir, "tracked.txt"), "hello world\n")
    const { diff } = await exec(tools.read_diff)({})
    git(["checkout", "--", "."]) // revert the direct edit; apply_patch should reproduce it
    const result = await exec(tools.apply_patch)({ patch: diff as string })
    expect(result.applied).toBe(true)
    expect(await fs.readFile(join(dir, "tracked.txt"), "utf8")).toBe("hello world\n")
  })

  it("apply_patch rejects a patch touching a path outside the workspace", async () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    const patch = ["--- /dev/null", "+++ b/../outside.txt", "@@ -0,0 +1 @@", "+pwned", ""].join(
      "\n",
    )
    await expect(exec(tools.apply_patch)({ patch })).rejects.toThrow(/escapes the workspace/)
  })

  it("run_tests uses MASTRA_AGENT_TEST_CMD when no command is given, and reports the exit code", async () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    const prev = process.env.MASTRA_AGENT_TEST_CMD
    process.env.MASTRA_AGENT_TEST_CMD = 'node -e "process.exit(0)"'
    try {
      const r = await exec(tools.run_tests)({})
      expect(r.exitCode).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.MASTRA_AGENT_TEST_CMD
      else process.env.MASTRA_AGENT_TEST_CMD = prev
    }
  })

  it("run_tests input.command overrides the env and reports a nonzero exit code", async () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    const r = await exec(tools.run_tests)({ command: 'node -e "process.exit(3)"' })
    expect(r.exitCode).toBe(3)
  })

  it("run_tests rejects a command whose argv0 isn't whitelisted", async () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    await expect(exec(tools.run_tests)({ command: "bash -c 'echo hi'" })).rejects.toThrow(
      /not allowed/,
    )
  })
})
