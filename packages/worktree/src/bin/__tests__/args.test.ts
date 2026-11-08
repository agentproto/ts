import { describe, it, expect } from "vitest"
import { resolve } from "node:path"
import { parseArgs, CliUsageError } from "../args.js"

describe("parseArgs", () => {
  it("maps required flags to a WorktreeAgentInput, defaulting deleteBranch true", () => {
    const { input, yes } = parseArgs(["run", "--repo", "/tmp/repo", "--slug", "fix-x", "--task", "do it", "--gate", "pnpm test"])
    expect(input).toEqual({
      repoRoot: resolve("/tmp/repo"),
      slug: "fix-x",
      task: "do it",
      gateCmd: "pnpm test",
      deleteBranch: true,
    })
    expect(yes).toBe(false)
  })

  it("maps all optional flags, repeated --copy-glob, --no-cleanup, and --yes", () => {
    const { input, yes } = parseArgs([
      "run",
      "--repo",
      "/tmp/repo",
      "--slug",
      "fix-x",
      "--task",
      "do it",
      "--gate",
      "pnpm test",
      "--base",
      "origin/main",
      "--harness",
      "hermes",
      "--deps-cmd",
      "pnpm install --prefer-offline",
      "--copy-glob",
      "envs/**/.env.local",
      "--copy-glob",
      "secrets/*.json",
      "--link",
      "node_modules",
      "--link",
      "projects/agentproto/ts",
      "--write-file",
      '{"path":"pnpm-workspace.yaml","content":"virtualStoreDir: /tmp/vstore\\n","mode":"append"}',
      "--no-cleanup",
      "--yes",
    ])
    expect(input).toEqual({
      repoRoot: resolve("/tmp/repo"),
      slug: "fix-x",
      task: "do it",
      gateCmd: "pnpm test",
      deleteBranch: false,
      base: "origin/main",
      harness: "hermes",
      depsCmd: "pnpm install --prefer-offline",
      copyGlobs: ["envs/**/.env.local", "secrets/*.json"],
      linkPaths: ["node_modules", "projects/agentproto/ts"],
      writeFiles: [{ path: "pnpm-workspace.yaml", content: "virtualStoreDir: /tmp/vstore\n", mode: "append" }],
    })
    expect(yes).toBe(true)
  })

  it("--harness sets the harness with no warning; the deprecated --adapter does the same and warns", () => {
    const base = ["run", "--repo", "/tmp/repo", "--slug", "s", "--task", "t", "--gate", "true"]
    const canonical = parseArgs([...base, "--harness", "hermes"])
    expect(canonical.input.harness).toBe("hermes")
    expect(canonical.warnings).toEqual([])
    const legacy = parseArgs([...base, "--adapter", "hermes"])
    expect(legacy.input.harness).toBe("hermes")
    expect(legacy.input.adapter).toBeUndefined()
    expect(legacy.warnings).toEqual([
      "worktree-agent: `--adapter` is deprecated and will be removed in the next major of @agentproto/runtime; use `--harness`",
    ])
  })

  it("throws CliUsageError when --write-file isn't valid JSON", () => {
    expect(() =>
      parseArgs(["run", "--repo", "/tmp/repo", "--slug", "s", "--task", "t", "--gate", "true", "--write-file", "not json"]),
    ).toThrow(/not valid JSON/)
  })

  it("throws CliUsageError when --write-file JSON is missing path/content", () => {
    expect(() =>
      parseArgs(["run", "--repo", "/tmp/repo", "--slug", "s", "--task", "t", "--gate", "true", "--write-file", '{"path":"x"}']),
    ).toThrow(/requires \{"path"/)
  })

  it("resolves a relative --repo against cwd", () => {
    const { input } = parseArgs(["run", "--repo", "./sub/repo", "--slug", "s", "--task", "t", "--gate", "true"])
    expect(input.repoRoot).toBe(resolve("./sub/repo"))
  })

  it("throws CliUsageError when the subcommand isn't 'run'", () => {
    expect(() => parseArgs([])).toThrow(CliUsageError)
    expect(() => parseArgs(["bogus"])).toThrow(CliUsageError)
  })

  it("throws CliUsageError listing every missing required flag", () => {
    expect(() => parseArgs(["run"])).toThrow(/--repo, --slug, --task, --gate/)
  })

  it("throws CliUsageError on an unrecognized flag", () => {
    expect(() =>
      parseArgs(["run", "--repo", "/tmp/repo", "--slug", "s", "--task", "t", "--gate", "true", "--bogus"]),
    ).toThrow(/unrecognized flag '--bogus'/)
  })

  it("throws CliUsageError when a flag is missing its value", () => {
    expect(() => parseArgs(["run", "--repo"])).toThrow(/requires a value/)
  })
})
