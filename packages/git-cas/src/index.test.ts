import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  type CasPushInput,
  type CasPushResult,
  buildCasPushArgv,
  buildCasPushCommand,
  casPush as realCasPush,
  classifyPush,
} from "./index.js"
import { plainPush } from "./plain-push-stub.js"
import { exitCodeFor, runCli } from "./run-cli.js"

// `GIT_CAS_IMPL=plain` runs the casPush cases against a plain `git push`
// stub; each of them must fail there.
const casPush: (i: CasPushInput) => Promise<CasPushResult> =
  process.env.GIT_CAS_IMPL === "plain"
    ? plainPush
    : (i) => realCasPush(i, { log: () => {} })

const ENV_KEYS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const
const savedEnv: Record<string, string | undefined> = {}
let root: string

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  process.env.GIT_AUTHOR_NAME = "t"
  process.env.GIT_AUTHOR_EMAIL = "t@example.invalid"
  process.env.GIT_COMMITTER_NAME = "t"
  process.env.GIT_COMMITTER_EMAIL = "t@example.invalid"
  root = mkdtempSync(join(tmpdir(), "git-cas-test-"))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

let seq = 0
function commit(cwd: string, label: string): string {
  writeFileSync(join(cwd, `f-${seq++}.txt`), label)
  git(cwd, "add", "-A")
  git(cwd, "commit", "-q", "-m", label)
  return git(cwd, "rev-parse", "HEAD")
}

/** Bare remote with `main` at one commit, plus a writer clone. */
function setup(): {
  bare: string
  clone: (name: string) => string
  remoteTip: (b?: string) => string | null
  hook: (body: string) => void
  marker: string
  base: string
} {
  const dir = mkdtempSync(join(root, "case-"))
  const bare = join(dir, "remote.git")
  git(dir, "init", "-q", "--bare", "-b", "main", bare)
  const clone = (name: string): string => {
    const c = join(dir, name)
    git(dir, "clone", "-q", bare, c)
    return c
  }
  const seed = clone("seed")
  const base = commit(seed, "A")
  git(seed, "push", "-q", "origin", "HEAD:refs/heads/main")
  const marker = join(dir, "hook-ran")
  return {
    bare,
    clone,
    base,
    marker,
    remoteTip: (b = "main") => {
      const out = git(bare, "for-each-ref", "--format=%(objectname)", `refs/heads/${b}`)
      return out === "" ? null : out
    },
    hook: (body) => {
      const p = join(bare, "hooks", "pre-receive")
      writeFileSync(p, `#!/bin/sh\ntouch '${marker}'\n${body}\n`)
      chmodSync(p, 0o755)
    },
  }
}

function reachable(bare: string, sha: string, from: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, from], {
      cwd: bare,
      stdio: "ignore",
    })
    return true
  } catch {
    return false
  }
}

describe("casPush", () => {
  it("two writers: W1 based on A, W2 pushed B → head_moved, remote stays B", async () => {
    const s = setup()
    const w1 = s.clone("w1")
    const w2 = s.clone("w2")
    const b = commit(w2, "B")
    git(w2, "push", "-q", "origin", "HEAD:main")
    const c = commit(w1, "C on A")

    const r = await casPush({ cwd: w1, branch: "main", expected: { sha: s.base } })

    expect(r).toEqual({ outcome: "head_moved", branch: "main", expected: s.base, actual: b })
    expect(s.remoteTip()).toBe(b)
    expect(reachable(s.bare, c, b)).toBe(false)
  })

  it("fix computed for A but committed on top of B → head_moved even though a plain push would fast-forward", async () => {
    const s = setup()
    const w2 = s.clone("w2")
    const b = commit(w2, "B")
    git(w2, "push", "-q", "origin", "HEAD:main")
    const w1 = s.clone("w1") // checks out the live tip B, like pr-fix
    commit(w1, "fix for A")

    const r = await casPush({ cwd: w1, branch: "main", expected: { sha: s.base } })

    expect(r).toEqual({ outcome: "head_moved", branch: "main", expected: s.base, actual: b })
    expect(s.remoteTip()).toBe(b)
  })

  it("own chain: pushed, then noop for the advanced and the repeated call", async () => {
    const s = setup()
    const w = s.clone("w")
    const t = commit(w, "T")

    const first = await casPush({ cwd: w, branch: "main", expected: { sha: s.base } })
    expect(first).toEqual({ outcome: "pushed", branch: "main", from: s.base, to: t })
    expect(s.remoteTip()).toBe(t)

    const advanced = await casPush({ cwd: w, branch: "main", expected: { sha: t } })
    expect(advanced).toEqual({ outcome: "noop", branch: "main", sha: t })

    const repeated = await casPush({ cwd: w, branch: "main", expected: { sha: s.base } })
    expect(repeated).toEqual({ outcome: "noop", branch: "main", sha: t })
    expect(s.remoteTip()).toBe(t)
  })

  it("{absent}: creates, re-run is noop, a different tip against the existing ref is head_moved", async () => {
    const s = setup()
    const w = s.clone("w")
    const t = commit(w, "T")

    const created = await casPush({ cwd: w, branch: "bot/new", expected: { absent: true } })
    expect(created).toEqual({ outcome: "pushed", branch: "bot/new", from: null, to: t })
    expect(s.remoteTip("bot/new")).toBe(t)

    const again = await casPush({ cwd: w, branch: "bot/new", expected: { absent: true } })
    expect(again).toEqual({ outcome: "noop", branch: "bot/new", sha: t })

    // A descendant of the existing ref: a plain push would fast-forward it.
    commit(w, "U")
    const moved = await casPush({ cwd: w, branch: "bot/new", expected: { absent: true } })
    expect(moved).toEqual({ outcome: "head_moved", branch: "bot/new", expected: null, actual: t })
    expect(s.remoteTip("bot/new")).toBe(t)
  })

  it("tip not descending from expected → rejected_other/not-descendant, no push attempted", async () => {
    const s = setup()
    const w = s.clone("w")
    git(w, "checkout", "-q", "--orphan", "unrelated")
    git(w, "rm", "-q", "-rf", ".")
    commit(w, "unrelated root")
    s.hook("exit 0")

    const r = await casPush({ cwd: w, branch: "main", expected: { sha: s.base } })

    expect(r).toMatchObject({ outcome: "rejected_other", branch: "main", reason: "not-descendant" })
    expect(existsSync(s.marker)).toBe(false)
    expect(s.remoteTip()).toBe(s.base)
  })

  it("pre-receive exit 1 → rejected_other/hook-declined", async () => {
    const s = setup()
    const w = s.clone("w")
    commit(w, "T")
    s.hook("echo 'nope' >&2\nexit 1")

    const r = await casPush({ cwd: w, branch: "main", expected: { sha: s.base } })

    expect(r).toMatchObject({ outcome: "rejected_other", branch: "main", reason: "hook-declined" })
    expect(existsSync(s.marker)).toBe(true)
    expect(s.remoteTip()).toBe(s.base)
  })
})

describe("classifyPush", () => {
  const A = "a".repeat(40)
  const B = "b".repeat(40)
  const T = "c".repeat(40)
  const sha = { sha: A }
  const cases: Array<{
    name: string
    out: string
    code: number
    after: string | null
    expected: { sha: string } | { absent: true }
    want: Record<string, unknown>
  }> = [
    {
      name: "forced update",
      out: `To /tmp/r.git\n+\t${T}:refs/heads/main\taaaaaaa...ccccccc (forced update)\nDone\n`,
      code: 0,
      after: null,
      expected: sha,
      want: { outcome: "pushed", branch: "main", from: A, to: T },
    },
    {
      name: "new branch",
      out: `To /tmp/r.git\n*\t${T}:refs/heads/bot/x\t[new branch]\nDone\n`,
      code: 0,
      after: null,
      expected: { absent: true },
      want: { outcome: "pushed", branch: "bot/x", from: null, to: T },
    },
    {
      name: "up to date",
      out: `To /tmp/r.git\n=\t${T}:refs/heads/main\t[up to date]\nDone\n`,
      code: 0,
      after: null,
      expected: { absent: true },
      want: { outcome: "noop", branch: "main", sha: T },
    },
    {
      name: "stale info, remote moved",
      out: `To /tmp/r.git\n!\t${T}:refs/heads/main\t[rejected] (stale info)\nDone\nerror: failed to push some refs to '/tmp/r.git'\n`,
      code: 1,
      after: B,
      expected: sha,
      want: { outcome: "head_moved", branch: "main", expected: A, actual: B },
    },
    {
      name: "protected branch",
      out: `To https://github.com/o/r.git\n!\t${T}:refs/heads/main\t[remote rejected] (protected branch hook declined)\nDone\n`,
      code: 1,
      after: A,
      expected: sha,
      want: { outcome: "rejected_other", branch: "main", reason: "protected" },
    },
    {
      name: "pre-receive declined",
      out: `To /tmp/r.git\n!\t${T}:refs/heads/main\t[remote rejected] (pre-receive hook declined)\nDone\n`,
      code: 1,
      after: A,
      expected: sha,
      want: { outcome: "rejected_other", branch: "main", reason: "hook-declined" },
    },
    {
      name: "403",
      out: "remote: Permission to o/r.git denied to bot.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403\n",
      code: 128,
      after: A,
      expected: sha,
      want: { outcome: "rejected_other", reason: "auth" },
    },
    {
      name: "no ref line",
      out: "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com\n",
      code: 128,
      after: A,
      expected: sha,
      want: { outcome: "rejected_other", reason: "network" },
    },
    {
      name: "ref line, unrecognised rejection",
      out: `To /tmp/r.git\n!\t${T}:refs/heads/main\t[rejected] (stale info)\nDone\n`,
      code: 1,
      after: A,
      expected: sha,
      want: { outcome: "rejected_other", branch: "main", reason: "unknown" },
    },
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(classifyPush(c.out, c.code, c.after, c.expected)).toMatchObject(c.want)
    })
  }

  it("redacts credentials and truncates detail to 2 KiB", () => {
    const out = `fatal: unable to access 'https://x-access-token:ghs_secret@github.com/o/r.git/': ${"x".repeat(5000)}`
    const r = classifyPush(out, 128, A, sha)
    expect(r.outcome).toBe("rejected_other")
    const detail = (r as { detail: string }).detail
    expect(detail).not.toContain("ghs_secret")
    expect(detail.length).toBeLessThanOrEqual(2048 + 3)
    expect(detail).toContain("https://github.com/o/r.git/")
  })
})

describe("buildCasPushArgv / buildCasPushCommand", () => {
  const sha = "0".repeat(39) + "1"

  it("builds the lease argv", () => {
    expect(
      buildCasPushArgv({ cwd: ".", branch: "main", expected: { sha }, noVerify: true }),
    ).toEqual([
      "push",
      "--porcelain",
      "--no-verify",
      `--force-with-lease=refs/heads/main:${sha}`,
      "origin",
      "HEAD:refs/heads/main",
    ])
    expect(buildCasPushArgv({ cwd: ".", branch: "n", expected: { absent: true } })).toContain(
      "--force-with-lease=refs/heads/n:",
    )
  })

  it("rejects an abbreviated expected sha and an option-like remote", () => {
    expect(() => buildCasPushArgv({ cwd: ".", branch: "m", expected: { sha: "abc1234" } })).toThrow()
    expect(() =>
      buildCasPushArgv({ cwd: ".", branch: "m", remote: "--upload-pack=x", expected: { absent: true } }),
    ).toThrow()
  })

  it("quotes a valid but shell-hostile branch so sh runs the exact push", async () => {
    const branch = "feat/it's-$x"
    expect(git(root, "check-ref-format", "--branch", branch)).toBe(branch)
    const s = setup()
    const w = s.clone("w")
    const t = commit(w, "T")

    const cmd = buildCasPushCommand({ cwd: w, branch, expected: { absent: true } })
    expect(cmd).toBe(
      `git push --porcelain '--force-with-lease=refs/heads/feat/it'\\''s-$x:' origin 'HEAD:refs/heads/feat/it'\\''s-$x'`,
    )
    execFileSync("sh", ["-c", cmd], { cwd: w, stdio: "ignore", env: { ...process.env, x: "EXPANDED" } })
    expect(s.remoteTip(branch)).toBe(t)
    expect(s.remoteTip("feat/it's-EXPANDED")).toBeNull()
  })
})

describe("cli", () => {
  it("prints the result JSON and maps outcomes to exit codes", async () => {
    const s = setup()
    const w = s.clone("w")
    const t = commit(w, "T")
    const out: string[] = []
    const err: string[] = []
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }

    expect(await runCli(["push", "--cwd", w, "--branch", "main", "--expect", s.base], io)).toBe(0)
    expect(JSON.parse(out[0] ?? "")).toEqual({ outcome: "pushed", branch: "main", from: s.base, to: t })
    const log = JSON.parse(err[0] ?? "")
    expect(log).toMatchObject({ event: "git_cas_push", outcome: "pushed", branch: "main", to: t })
    expect(typeof log.durationMs).toBe("number")

    commit(w, "U")
    expect(await runCli(["push", "--cwd", w, "--branch", "main", "--expect-absent"], io)).toBe(3)
    expect(await runCli(["push", "--branch", "main"], io)).toBe(2)
    expect(exitCodeFor({ outcome: "rejected_other", branch: "m", reason: "auth", detail: "" })).toBe(4)
  })
})
