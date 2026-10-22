/**
 * WP-F Part 2: `resolveWorktreesTurboCacheDir`'s precedence — the shared
 * cache directory `runSetup` points every worktree's setup hooks at.
 */

import { afterEach, describe, expect, it } from "vitest"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  resolveWorktreesTurboCacheDir,
  resolveWorktreesTurboConcurrency,
  WORKTREES_TURBO_CACHE_DIR_ENV,
  WORKTREES_TURBO_CONCURRENCY_ENV,
  worktreesConcurrencyEnv,
} from "../env.js"

const ORIGINAL_PINNED = process.env[WORKTREES_TURBO_CACHE_DIR_ENV]
const ORIGINAL_AMBIENT = process.env.TURBO_CACHE_DIR
const ORIGINAL_CONC_PINNED = process.env[WORKTREES_TURBO_CONCURRENCY_ENV]
const ORIGINAL_CONC_AMBIENT = process.env.TURBO_CONCURRENCY

describe("resolveWorktreesTurboCacheDir", () => {
  afterEach(() => {
    if (ORIGINAL_PINNED === undefined) delete process.env[WORKTREES_TURBO_CACHE_DIR_ENV]
    else process.env[WORKTREES_TURBO_CACHE_DIR_ENV] = ORIGINAL_PINNED
    if (ORIGINAL_AMBIENT === undefined) delete process.env.TURBO_CACHE_DIR
    else process.env.TURBO_CACHE_DIR = ORIGINAL_AMBIENT
  })

  it("defaults to a single, real ~/.agentproto/turbo-cache when nothing is set", () => {
    delete process.env[WORKTREES_TURBO_CACHE_DIR_ENV]
    delete process.env.TURBO_CACHE_DIR
    expect(resolveWorktreesTurboCacheDir()).toBe(join(homedir(), ".agentproto", "turbo-cache"))
  })

  it("respects an already-exported bare TURBO_CACHE_DIR (AGENTS.md's own manual-use advice)", () => {
    delete process.env[WORKTREES_TURBO_CACHE_DIR_ENV]
    process.env.TURBO_CACHE_DIR = "/custom/ambient-cache"
    expect(resolveWorktreesTurboCacheDir()).toBe("/custom/ambient-cache")
  })

  it("the dedicated AGENTPROTO_ override wins over a bare ambient TURBO_CACHE_DIR", () => {
    process.env[WORKTREES_TURBO_CACHE_DIR_ENV] = "/pinned/cache"
    process.env.TURBO_CACHE_DIR = "/custom/ambient-cache"
    expect(resolveWorktreesTurboCacheDir()).toBe("/pinned/cache")
  })

  it("resolves a relative pinned override against the daemon's cwd", () => {
    delete process.env.TURBO_CACHE_DIR
    process.env[WORKTREES_TURBO_CACHE_DIR_ENV] = "relative-cache"
    expect(resolveWorktreesTurboCacheDir()).toBe(join(process.cwd(), "relative-cache"))
  })
})

describe("resolveWorktreesTurboConcurrency", () => {
  afterEach(() => {
    if (ORIGINAL_CONC_PINNED === undefined) delete process.env[WORKTREES_TURBO_CONCURRENCY_ENV]
    else process.env[WORKTREES_TURBO_CONCURRENCY_ENV] = ORIGINAL_CONC_PINNED
    if (ORIGINAL_CONC_AMBIENT === undefined) delete process.env.TURBO_CONCURRENCY
    else process.env.TURBO_CONCURRENCY = ORIGINAL_CONC_AMBIENT
  })

  it("defaults to 2 (safe on the smallest 4-vCPU sandbox box)", () => {
    delete process.env[WORKTREES_TURBO_CONCURRENCY_ENV]
    delete process.env.TURBO_CONCURRENCY
    expect(resolveWorktreesTurboConcurrency()).toBe(2)
  })

  it("respects an already-exported bare TURBO_CONCURRENCY", () => {
    delete process.env[WORKTREES_TURBO_CONCURRENCY_ENV]
    process.env.TURBO_CONCURRENCY = "8"
    expect(resolveWorktreesTurboConcurrency()).toBe(8)
  })

  it("the dedicated AGENTPROTO_ override wins over a bare ambient TURBO_CONCURRENCY", () => {
    process.env[WORKTREES_TURBO_CONCURRENCY_ENV] = "3"
    process.env.TURBO_CONCURRENCY = "8"
    expect(resolveWorktreesTurboConcurrency()).toBe(3)
  })

  it("ignores a non-integer / out-of-range override and falls through", () => {
    process.env[WORKTREES_TURBO_CONCURRENCY_ENV] = "0"
    process.env.TURBO_CONCURRENCY = "4"
    expect(resolveWorktreesTurboConcurrency()).toBe(4)
    process.env[WORKTREES_TURBO_CONCURRENCY_ENV] = "garbage"
    expect(resolveWorktreesTurboConcurrency()).toBe(4)
  })

  it("rejects partially-numeric strings instead of truncating them", () => {
    process.env[WORKTREES_TURBO_CONCURRENCY_ENV] = "3abc"
    process.env.TURBO_CONCURRENCY = "4"
    expect(resolveWorktreesTurboConcurrency()).toBe(4)
    process.env.TURBO_CONCURRENCY = "2.5"
    expect(resolveWorktreesTurboConcurrency()).toBe(2)
  })

  it("resolves from an explicit base env instead of process.env", () => {
    process.env.TURBO_CONCURRENCY = "8"
    expect(resolveWorktreesTurboConcurrency({ TURBO_CONCURRENCY: "5" })).toBe(5)
  })
})

describe("worktreesConcurrencyEnv", () => {
  it("sets both TURBO_CONCURRENCY and pnpm's npm_config_workspace_concurrency", () => {
    expect(worktreesConcurrencyEnv({})).toEqual({
      TURBO_CONCURRENCY: "2",
      npm_config_workspace_concurrency: "2",
    })
  })

  it("respects an already-set npm_config_workspace_concurrency", () => {
    expect(
      worktreesConcurrencyEnv({ TURBO_CONCURRENCY: "6", npm_config_workspace_concurrency: "3" }),
    ).toEqual({ TURBO_CONCURRENCY: "6", npm_config_workspace_concurrency: "3" })
  })
})
