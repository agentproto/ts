import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  makeUnwiredToolStub,
  makeWorkspaceTools,
  resolveInCwd,
  withTimeoutGuard,
} from "../workspace-tools.js"

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
      "command_execute",
      "directory_list",
      "edit_file",
      "file_info",
      "file_read",
      "file_write",
      "list_dir",
      "read_diff",
      "read_file",
      "run_command",
      "run_tests",
      "write_file",
    ])
  })

  it("withholds read_diff/apply_patch/run_tests/command_execute when allowExec is false", () => {
    const tools = makeWorkspaceTools({ cwd: dir, allowExec: false })
    expect(tools.read_diff).toBeUndefined()
    expect(tools.apply_patch).toBeUndefined()
    expect(tools.run_tests).toBeUndefined()
    expect(tools.command_execute).toBeUndefined()
    // The always-on, non-exec daemon-vocabulary aliases stay available.
    expect(tools.file_read).toBeDefined()
    expect(tools.file_write).toBeDefined()
    expect(tools.directory_list).toBeDefined()
    expect(tools.file_info).toBeDefined()
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

  it("file_read/file_write/directory_list are aliases of read_file/write_file/list_dir", async () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    await exec(tools.file_write)({ path: "alias.txt", content: "aliased" })
    expect((await exec(tools.file_read)({ path: "alias.txt" })).content).toBe("aliased")
    expect((await exec(tools.directory_list)({ path: "." })).entries).toContain("alias.txt")
  })

  it("file_info stats a file with the daemon-compatible shape", async () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    await exec(tools.write_file)({ path: "stat-me.txt", content: "12345" })
    const info = await exec(tools.file_info)({ path: "stat-me.txt" })
    expect(info).toMatchObject({ name: "stat-me.txt", path: "stat-me.txt", type: "file", size: 5 })
    expect(typeof info.modified).toBe("string")
    expect(typeof info.created).toBe("string")
  })

  it("file_info reports directories with type 'directory'", async () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    await fs.mkdir(join(dir, "a-dir"), { recursive: true })
    const info = await exec(tools.file_info)({ path: "a-dir" })
    expect(info).toMatchObject({ type: "directory" })
  })
})

describe("command_execute (allowlist-gated)", () => {
  let dir: string
  const exec = (tool: { execute?: unknown } | undefined) =>
    (tool!.execute as (i: unknown) => Promise<Record<string, unknown>>)

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "mastra-ws-cmdexec-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("denies by default when no allowlist file exists", async () => {
    const tools = makeWorkspaceTools({ cwd: dir })
    await expect(exec(tools.command_execute)({ command: "echo", args: ["hi"] })).rejects.toThrow(
      /not in the workspace allowlist/,
    )
  })

  it("runs an allowlisted command and returns stdout/exitCode", async () => {
    await fs.mkdir(join(dir, ".agentproto"), { recursive: true })
    await fs.writeFile(
      join(dir, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: ["echo"] }),
    )
    const tools = makeWorkspaceTools({ cwd: dir })
    const r = await exec(tools.command_execute)({ command: "echo", args: ["hi", "there"] })
    expect(r.exitCode).toBe(0)
    expect((r.stdout as string).trim()).toBe("hi there")
  })

  it("denies an allowlisted basename whose args don't match a constrained entry", async () => {
    await fs.mkdir(join(dir, ".agentproto"), { recursive: true })
    await fs.writeFile(
      join(dir, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: [{ command: "git", args: ["status"] }] }),
    )
    const tools = makeWorkspaceTools({ cwd: dir })
    await expect(
      exec(tools.command_execute)({ command: "git", args: ["push"] }),
    ).rejects.toThrow(/doesn't match any allowed pattern/)
  })
})

describe("makeUnwiredToolStub — fail-fast for a declared-but-unwired tool", () => {
  it("exposes the id and rejects immediately with a clear message on call", async () => {
    const stub = makeUnwiredToolStub("mailbox_list")
    expect(stub.id).toBe("mailbox_list")
    await expect((stub.execute as (i: unknown) => Promise<unknown>)({})).rejects.toThrow(
      /'mailbox_list' is declared in AGENT\.md but not wired/,
    )
  })
})

describe("withTimeoutGuard", () => {
  it("resolves normally when the wrapped call finishes in time", async () => {
    const guarded = withTimeoutGuard("fast_tool", 1000, async (n: number) => n * 2)
    await expect(guarded(21)).resolves.toBe(42)
  })

  it("rejects with a clear timeout error, and doesn't leave the call pending forever", async () => {
    vi.useFakeTimers()
    try {
      const neverResolves = () => new Promise<never>(() => {})
      const guarded = withTimeoutGuard("slow_tool", 5000, neverResolves)
      const pending = guarded(undefined)
      const assertion = expect(pending).rejects.toThrow(
        /tool 'slow_tool' timed out after 5000ms/,
      )
      await vi.advanceTimersByTimeAsync(5000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
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

describe("read_diff / run_command: git ceiling (fixes #818)", () => {
  let parentDir: string
  let childDir: string
  const git = (dir: string, args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" })

  beforeAll(async () => {
    // Create a git repo as the parent, with a committed file and an uncommitted change
    parentDir = await fs.mkdtemp(join(tmpdir(), "mastra-parent-git-"))
    git(parentDir, ["init", "-q"])
    git(parentDir, ["config", "user.email", "test@example.com"])
    git(parentDir, ["config", "user.name", "Test"])
    await fs.writeFile(join(parentDir, "parent.txt"), "initial\n")
    git(parentDir, ["add", "."])
    git(parentDir, ["commit", "-q", "-m", "parent commit"])
    await fs.writeFile(join(parentDir, "parent.txt"), "modified\n")

    // Create a non-git subdirectory inside the parent repo
    childDir = join(parentDir, "child-workspace")
    await fs.mkdir(childDir)
    await fs.writeFile(join(childDir, "child.txt"), "child content\n")
  })

  afterAll(async () => {
    await fs.rm(parentDir, { recursive: true, force: true })
  })

  const exec = (tool: { execute?: unknown } | undefined) =>
    (tool!.execute as (i: unknown) => Promise<Record<string, unknown>>)

  it("read_diff on a non-git workspace inside a git repo does not discover the parent repo", async () => {
    const tools = makeWorkspaceTools({ cwd: childDir })
    // Without the GIT_CEILING_DIRECTORIES fix, this would show parent.txt changes;
    // with the fix, git sees no repo and returns an error or empty diff.
    await expect(exec(tools.read_diff)({})).rejects.toThrow(/git diff failed/)
  })

  it("run_command with 'git status' on a non-git workspace inside a git repo does not discover the parent repo", async () => {
    const tools = makeWorkspaceTools({ cwd: childDir })
    const r = await exec(tools.run_command)({ command: "git status" })
    // Without the fix, git would discover the parent repo and return exitCode 0.
    // With the fix, git fails to find a repo (exits nonzero).
    expect(r.exitCode).not.toBe(0)
    expect((r.stderr as string).toLowerCase()).toContain("not a git repository")
  })
})
