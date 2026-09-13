/**
 * WP-F Part 2: `resolveWorktreesTurboCacheDir`'s precedence — the shared
 * cache directory `runSetup` points every worktree's setup hooks at.
 */

import { afterEach, describe, expect, it } from "vitest"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  resolveWorktreesTurboCacheDir,
  WORKTREES_TURBO_CACHE_DIR_ENV,
} from "../env.js"

const ORIGINAL_PINNED = process.env[WORKTREES_TURBO_CACHE_DIR_ENV]
const ORIGINAL_AMBIENT = process.env.TURBO_CACHE_DIR

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
