import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

test("gh_open_pr reports head_moved and leaves an existing remote branch untouched", async (t) => {
  const saved = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  }
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"
  process.env.GIT_CONFIG_NOSYSTEM = "1"

  const root = mkdtempSync(path.join(tmpdir(), "tools-gh-open-pr-"))
  const prevCwd = process.cwd()
  t.after(() => {
    process.chdir(prevCwd)
    rmSync(root, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  const bare = path.join(root, "remote.git")
  const work = path.join(root, "work")
  mkdirSync(bare)
  git(bare, "init", "--bare", "-q")
  mkdirSync(work)
  git(work, "init", "-q")
  git(work, "config", "user.name", "t")
  git(work, "config", "user.email", "t@example.invalid")
  git(work, "checkout", "-q", "-b", "main")
  writeFileSync(path.join(work, "a.txt"), "a")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "main")
  git(work, "remote", "add", "origin", bare)
  git(work, "push", "-q", "-u", "origin", "main")

  git(work, "checkout", "-q", "-b", "other")
  writeFileSync(path.join(work, "b.txt"), "b")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "other")
  const otherSha = git(work, "rev-parse", "HEAD")
  git(work, "push", "-q", "origin", "HEAD:refs/heads/bot/fix-9")
  git(work, "checkout", "-q", "main")
  writeFileSync(path.join(work, "a.txt"), "changed")

  process.chdir(work)
  const { buildToolset } = await import(`./tools.mjs?case=${Date.now()}`)
  const { impls } = buildToolset(["gh_open_pr"], {})
  const out = await impls.gh_open_pr({ branch: "bot/fix-9", title: "t", body: "b" })

  assert.match(out, /head_moved/)
  const remoteSha = git(work, "ls-remote", "origin", "refs/heads/bot/fix-9").split("\t")[0]
  assert.equal(remoteSha, otherSha)
})
