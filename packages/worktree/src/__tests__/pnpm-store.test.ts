/**
 * Shared pnpm store for worktrees (pnpm-store.ts): where the store lives,
 * what env a setup hook gets, and how a worktree's own out-of-tree virtual
 * store is found for cleanup.
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PNPM_STORE_DIRNAME,
  WORKTREES_PNPM_STORE_DIR_ENV,
  findWorktreeVirtualStore,
  resolveWorktreesPnpmStoreDir,
  worktreesPnpmStoreEnv,
} from "../pnpm-store.js"
import { runSetup } from "../lifecycle.js"

const cleanupPaths: string[] = []
afterEach(async () => {
  while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
})

async function tmp(prefix: string): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), prefix)))
  cleanupPaths.push(dir)
  return dir
}

describe("resolveWorktreesPnpmStoreDir", () => {
  it("defaults to a store next to the worktree, in its pool, so it shares the worktrees' volume", () => {
    expect(resolveWorktreesPnpmStoreDir("/vol/wt/repo/feat", {})).toBe(join("/vol/wt/repo", PNPM_STORE_DIRNAME))
  })

  it("an explicit override wins over the pool default", () => {
    expect(resolveWorktreesPnpmStoreDir("/vol/wt/repo/feat", { [WORKTREES_PNPM_STORE_DIR_ENV]: "/pinned/store" })).toBe(
      "/pinned/store",
    )
  })

  it("never inherits a store from the ambient pnpm env: it may sit on another volume, which forces copies", () => {
    expect(resolveWorktreesPnpmStoreDir("/vol/wt/repo/feat", { npm_config_store_dir: "/other-volume/store" })).toBe(
      join("/vol/wt/repo", PNPM_STORE_DIRNAME),
    )
  })
})

describe("worktreesPnpmStoreEnv", () => {
  it("sets the shared store dir and clone-or-copy as the import method", () => {
    expect(worktreesPnpmStoreEnv("/vol/wt/repo/feat", {})).toEqual({
      npm_config_store_dir: join("/vol/wt/repo", PNPM_STORE_DIRNAME),
      npm_config_package_import_method: "clone-or-copy",
    })
  })

  it("respects an import method the operator already chose", () => {
    expect(worktreesPnpmStoreEnv("/vol/wt/repo/feat", { npm_config_package_import_method: "hardlink" })).toMatchObject({
      npm_config_package_import_method: "hardlink",
    })
  })
})

describe("runSetup passes the shared store env to setup hooks", () => {
  it("hooks see the shared store dir and the import method", async () => {
    const pool = await tmp("wt-pnpm-pool-")
    const wt = join(pool, "feat")
    await mkdir(wt)
    const out = join(pool, "env.json")
    const hook = `node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify([process.env.npm_config_store_dir, process.env.npm_config_package_import_method]))" ${out}`
    await runSetup(
      { worktree: { setup: hook } },
      { sourceCheckoutPath: pool, worktreePath: wt, branchName: "wt/feat" },
    )
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual([join(pool, PNPM_STORE_DIRNAME), "clone-or-copy"])
  })

  it("an explicit env passed by the caller wins", async () => {
    const pool = await tmp("wt-pnpm-pool-")
    const wt = join(pool, "feat")
    await mkdir(wt)
    const out = join(pool, "env.json")
    const hook = `node -e "require('fs').writeFileSync(process.argv[1], process.env.npm_config_store_dir)" ${out}`
    await runSetup(
      { worktree: { setup: hook } },
      { sourceCheckoutPath: pool, worktreePath: wt, branchName: "wt/feat" },
      { env: { npm_config_store_dir: "/caller/store" } },
    )
    expect(await readFile(out, "utf8")).toBe("/caller/store")
  })
})

describe("findWorktreeVirtualStore", () => {
  async function setup(yaml: string | null, npmrc?: string): Promise<{ wt: string; vstores: string }> {
    const base = await tmp("wt-vstore-")
    const wt = join(base, "pool", "feat")
    const vstores = join(base, "vstores")
    await mkdir(wt, { recursive: true })
    await mkdir(join(vstores, "feat"), { recursive: true })
    if (yaml !== null) await writeFile(join(wt, "pnpm-workspace.yaml"), yaml.replaceAll("{VS}", vstores))
    if (npmrc !== undefined) await writeFile(join(wt, ".npmrc"), npmrc.replaceAll("{VS}", vstores))
    return { wt, vstores }
  }

  it("finds an absolute virtualStoreDir outside the worktree that is named after the worktree", async () => {
    const { wt, vstores } = await setup("packages:\n  - a\nvirtualStoreDir: {VS}/feat\n")
    expect(findWorktreeVirtualStore(wt)).toBe(join(vstores, "feat"))
  })

  it("the last virtualStoreDir wins, as an appended per-worktree override does", async () => {
    const { wt, vstores } = await setup("virtualStoreDir: .pnpm-vstores/shared\nvirtualStoreDir: '{VS}/feat'\n")
    expect(findWorktreeVirtualStore(wt)).toBe(join(vstores, "feat"))
  })

  it("reads the .npmrc spelling too", async () => {
    const { wt, vstores } = await setup(null, "virtual-store-dir={VS}/feat\n")
    expect(findWorktreeVirtualStore(wt)).toBe(join(vstores, "feat"))
  })

  it("ignores a virtual store inside the worktree: it dies with the worktree anyway", async () => {
    const { wt } = await setup("virtualStoreDir: .pnpm-vstores/feat\n")
    expect(findWorktreeVirtualStore(wt)).toBeUndefined()
  })

  it("ignores a shared directory that is not named after this worktree", async () => {
    const { wt, vstores } = await setup("virtualStoreDir: {VS}\n")
    expect(findWorktreeVirtualStore(wt)).toBeUndefined()
    expect(existsSync(vstores)).toBe(true)
  })

  it("ignores a path that does not exist or a worktree with no pnpm config", async () => {
    const { wt } = await setup("virtualStoreDir: /nonexistent-place/feat\n")
    expect(findWorktreeVirtualStore(wt)).toBeUndefined()
    const bare = await setup(null)
    expect(findWorktreeVirtualStore(bare.wt)).toBeUndefined()
  })

  it("never targets an ancestor of the worktree or the filesystem root", async () => {
    const base = await tmp("wt-vstore-")
    const wt = join(base, "feat")
    await mkdir(wt, { recursive: true })
    await writeFile(join(wt, "pnpm-workspace.yaml"), `virtualStoreDir: ${base}\n`)
    expect(findWorktreeVirtualStore(wt)).toBeUndefined()
  })
})
