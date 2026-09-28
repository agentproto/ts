import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseLocalWorktreeConfig,
  loadLocalWorktreeConfig,
  applySlugPlaceholder,
  resolveLocalWriteFiles,
  LOCAL_WORKTREE_CONFIG_REL,
} from "../local-config.js"
import { ConfigError } from "../config.js"

describe("parseLocalWorktreeConfig", () => {
  it("parses a full valid config", () => {
    const config = parseLocalWorktreeConfig(
      JSON.stringify({
        copyGlobs: ["envs/**/.env.local"],
        cloneGlobs: ["node_modules"],
        writeFiles: [{ path: "pnpm-workspace.yaml", content: "virtualStoreDir: x\n", mode: "append" }],
        depsCmd: "pnpm install --prefer-offline",
        linkPaths: ["../sibling-repo"],
      }),
    )
    expect(config.copyGlobs).toEqual(["envs/**/.env.local"])
    expect(config.cloneGlobs).toEqual(["node_modules"])
    expect(config.writeFiles).toEqual([
      { path: "pnpm-workspace.yaml", content: "virtualStoreDir: x\n", mode: "append" },
    ])
    expect(config.depsCmd).toBe("pnpm install --prefer-offline")
    expect(config.linkPaths).toEqual(["../sibling-repo"])
  })

  it("accepts an empty object", () => {
    expect(parseLocalWorktreeConfig("{}")).toEqual({})
  })

  it("rejects malformed JSON", () => {
    expect(() => parseLocalWorktreeConfig("{ not json")).toThrow(ConfigError)
  })

  it("rejects a non-array cloneGlobs", () => {
    expect(() => parseLocalWorktreeConfig(JSON.stringify({ cloneGlobs: "node_modules" }))).toThrow(
      ConfigError,
    )
  })

  it("rejects a writeFiles entry missing content", () => {
    expect(() =>
      parseLocalWorktreeConfig(JSON.stringify({ writeFiles: [{ path: "x" }] })),
    ).toThrow(ConfigError)
  })

  it("rejects a writeFiles entry with an empty path", () => {
    expect(() =>
      parseLocalWorktreeConfig(JSON.stringify({ writeFiles: [{ path: "", content: "x" }] })),
    ).toThrow(ConfigError)
  })

  it("rejects an unknown writeFiles mode", () => {
    expect(() =>
      parseLocalWorktreeConfig(
        JSON.stringify({ writeFiles: [{ path: "x", content: "y", mode: "clobber" }] }),
      ),
    ).toThrow(ConfigError)
  })
})

describe("loadLocalWorktreeConfig (disk read, never git show)", () => {
  const cleanup: string[] = []
  afterEach(async () => {
    while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
  })

  it("returns null when the workspace has no .agentproto/worktree.json", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "wt-localcfg-"))
    cleanup.push(workspace)
    expect(await loadLocalWorktreeConfig(workspace)).toBeNull()
  })

  it("reads the file straight off disk — no commit or git repo required", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "wt-localcfg-"))
    cleanup.push(workspace)
    await mkdir(join(workspace, ".agentproto"), { recursive: true })
    await writeFile(
      join(workspace, LOCAL_WORKTREE_CONFIG_REL),
      JSON.stringify({ depsCmd: "pnpm install", cloneGlobs: ["node_modules"] }),
    )
    const config = await loadLocalWorktreeConfig(workspace)
    expect(config?.depsCmd).toBe("pnpm install")
    expect(config?.cloneGlobs).toEqual(["node_modules"])
  })

  it("throws ConfigError on a present-but-invalid file", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "wt-localcfg-"))
    cleanup.push(workspace)
    await mkdir(join(workspace, ".agentproto"), { recursive: true })
    await writeFile(join(workspace, LOCAL_WORKTREE_CONFIG_REL), "{ not json")
    await expect(loadLocalWorktreeConfig(workspace)).rejects.toThrow(ConfigError)
  })
})

describe("applySlugPlaceholder / resolveLocalWriteFiles", () => {
  it("substitutes a literal {slug} token", () => {
    expect(applySlugPlaceholder("virtualStoreDir: /store/{slug}\n", "my-feature")).toBe(
      "virtualStoreDir: /store/my-feature\n",
    )
  })

  it("leaves text with no placeholder untouched", () => {
    expect(applySlugPlaceholder("no token here\n", "my-feature")).toBe("no token here\n")
  })

  it("substitutes {slug} in both path and content, per worktree", () => {
    const resolved = resolveLocalWriteFiles(
      [{ path: "stores/{slug}.yaml", content: "virtualStoreDir: /store/{slug}\n" }],
      "feat-42",
    )
    expect(resolved).toEqual([
      { path: "stores/feat-42.yaml", content: "virtualStoreDir: /store/feat-42\n" },
    ])
  })

  it("returns an empty array for undefined input", () => {
    expect(resolveLocalWriteFiles(undefined, "feat-42")).toEqual([])
  })
})
