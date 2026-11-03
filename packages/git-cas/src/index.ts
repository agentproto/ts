/**
 * Compare-and-swap push: update `refs/heads/<branch>` on a remote only if it
 * still points at the SHA the caller's work is based on.
 *
 * A plain `git push` already refuses a non-fast-forward, but it succeeds
 * whenever the local commit happens to sit on top of a head someone else
 * moved. The lease (`--force-with-lease=<ref>:<expected>`) closes that: the
 * update carries the expected old OID, so a ref that moved is rejected even
 * when the new tip would fast-forward it. Because a lease push is a force
 * push, the ancestry of the local tip is checked before any network write.
 *
 * The library never retries, fetches, rebases or writes CI outputs. It
 * returns a typed outcome and prints one JSON log line per call.
 */

import { execFile } from "node:child_process"

export type CasExpected = { sha: string } | { absent: true }

export interface CasPushInput {
  cwd: string
  /** Remote name or URL. Default `"origin"`. */
  remote?: string
  /** Target branch; the refspec is `<localRef>:refs/heads/<branch>`. */
  branch: string
  expected: CasExpected
  /** Default `"HEAD"`. */
  localRef?: string
  /** Default `false`. */
  noVerify?: boolean
}

export type CasRejectReason =
  | "not-descendant"
  | "protected"
  | "hook-declined"
  | "auth"
  | "network"
  | "unknown"

export type CasPushResult =
  | { outcome: "pushed"; branch: string; from: string | null; to: string }
  | { outcome: "noop"; branch: string; sha: string }
  | {
      outcome: "head_moved"
      branch: string
      expected: string | null
      actual: string | null
    }
  | {
      outcome: "rejected_other"
      branch: string
      reason: CasRejectReason
      detail: string
    }

export interface CasPushOptions {
  /** Receives the JSON log line (no trailing newline). Default: stdout. */
  log?: (line: string) => void
}

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const DETAIL_MAX = 2048
const AUTH_RE =
  /\b(?:401|403)\b|authentication failed|permission denied|could not read username/i

/** Sentence appended to box prompts next to `buildCasPushCommand`. */
export const CAS_STOP_RULE =
  "If this push prints `(stale info)` or `[rejected]`, STOP: do not pull, rebase, merge or retry; end your turn reporting `head_moved`."

function expectedSha(expected: CasExpected): string | null {
  return "sha" in expected ? expected.sha : null
}

function validate(i: CasPushInput): void {
  if (!i.branch) throw new Error("git-cas: branch is required")
  const remote = i.remote ?? "origin"
  if (remote.startsWith("-")) {
    throw new Error(`git-cas: remote must not start with "-": ${remote}`)
  }
  const sha = expectedSha(i.expected)
  if (sha !== null && !SHA_RE.test(sha)) {
    throw new Error(
      `git-cas: expected.sha must be a full lowercase hex object id, got "${sha}"`,
    )
  }
}

/** Git arguments (without the leading `git`) for the lease push. Pure. */
export function buildCasPushArgv(i: CasPushInput): string[] {
  validate(i)
  const ref = `refs/heads/${i.branch}`
  const argv = ["push", "--porcelain"]
  if (i.noVerify) argv.push("--no-verify")
  argv.push(`--force-with-lease=${ref}:${expectedSha(i.expected) ?? ""}`)
  argv.push(i.remote ?? "origin", `${i.localRef ?? "HEAD"}:${ref}`)
  return argv
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** The same push as one POSIX-shell command line, for box prompts. Pure. */
export function buildCasPushCommand(i: CasPushInput): string {
  return ["git", ...buildCasPushArgv(i)].map(shellQuote).join(" ")
}

/** Strip userinfo (`x-access-token:<token>@`) from any URL in `text`. */
function redact(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1")
}

function truncate(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}...` : text
}

const REF_LINE_RE = /^[ +\-*!=]\t([^\t]*):(refs\/[^\t]*)\t(.*)$/m

/**
 * Map a lease push's result to an outcome. Pure.
 *
 * `porcelain` is the push's stdout followed by its stderr; `actualAfter` is
 * the remote branch tip read after a failed push (ignored on exit 0).
 */
export function classifyPush(
  porcelain: string,
  exitCode: number,
  actualAfter: string | null,
  expected: CasExpected,
): CasPushResult {
  const refLine = REF_LINE_RE.exec(porcelain)
  const branch = refLine?.[2]?.replace(/^refs\/heads\//, "") ?? ""
  const want = expectedSha(expected)
  if (exitCode === 0) {
    const src = refLine?.[1] ?? ""
    const to = SHA_RE.test(src) ? src : (actualAfter ?? src)
    if (refLine && porcelain.match(/^=\t/m)) {
      return { outcome: "noop", branch, sha: to }
    }
    return { outcome: "pushed", branch, from: want, to }
  }
  if (actualAfter !== want) {
    return { outcome: "head_moved", branch, expected: want, actual: actualAfter }
  }
  const detail = truncate(redact(porcelain.trim()))
  let reason: CasRejectReason
  if (/\[remote rejected\][^\n]*protected/i.test(porcelain)) reason = "protected"
  else if (/\[remote rejected\]/.test(porcelain)) reason = "hook-declined"
  else if (AUTH_RE.test(porcelain)) reason = "auth"
  else if (!refLine) reason = "network"
  else reason = "unknown"
  return { outcome: "rejected_other", branch, reason, detail }
}

interface GitRun {
  code: number
  stdout: string
  stderr: string
}

function git(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code =
          err == null ? 0 : typeof err.code === "number" ? err.code : 1
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

type RemoteTip = { ok: true; sha: string | null } | { ok: false; text: string }

async function lsRemote(
  cwd: string,
  remote: string,
  ref: string,
): Promise<RemoteTip> {
  const r = await git(cwd, ["ls-remote", remote, ref])
  if (r.code !== 0) return { ok: false, text: `${r.stdout}\n${r.stderr}` }
  for (const line of r.stdout.split("\n")) {
    const [sha, name] = line.split("\t")
    if (name === ref && sha) return { ok: true, sha }
  }
  return { ok: true, sha: null }
}

function failureReason(text: string): CasRejectReason {
  return AUTH_RE.test(text) ? "auth" : "network"
}

/**
 * Push `localRef` to `refs/heads/<branch>` only if the remote branch still
 * equals `expected`. See the package README for the step-by-step contract.
 */
export async function casPush(
  i: CasPushInput,
  opts: CasPushOptions = {},
): Promise<CasPushResult> {
  const started = Date.now()
  const remote = i.remote ?? "origin"
  const want = expectedSha(i.expected)
  const result = await run()
  const line: Record<string, unknown> = {
    event: "git_cas_push",
    outcome: result.outcome,
  }
  if (result.outcome === "rejected_other") line.reason = result.reason
  line.remote = redact(remote)
  line.branch = i.branch
  line.expected = want
  line.actual =
    result.outcome === "head_moved"
      ? result.actual
      : result.outcome === "pushed"
        ? result.to
        : result.outcome === "noop"
          ? result.sha
          : null
  line.to = result.outcome === "pushed" ? result.to : null
  if (result.outcome === "rejected_other") line.detail = result.detail
  line.durationMs = Date.now() - started
  const log = opts.log ?? ((s: string) => process.stdout.write(`${s}\n`))
  log(JSON.stringify(line))
  return result

  async function run(): Promise<CasPushResult> {
    validate(i)
    const branch = i.branch
    const ref = `refs/heads/${branch}`
    const reject = (reason: CasRejectReason, text: string): CasPushResult => ({
      outcome: "rejected_other",
      branch,
      reason,
      detail: truncate(redact(text.trim())),
    })

    // 1. Local tip and remote tip.
    const rev = await git(i.cwd, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${i.localRef ?? "HEAD"}^{commit}`,
    ])
    if (rev.code !== 0) return reject("unknown", rev.stderr)
    const tip = rev.stdout.trim()
    const before = await lsRemote(i.cwd, remote, ref)
    if (!before.ok) return reject(failureReason(before.text), before.text)

    // 2. Remote already at our tip: nothing to write.
    if (before.sha === tip) return { outcome: "noop", branch, sha: tip }

    // 3. Preconditions, no network write.
    if (want !== null) {
      const anc = await git(i.cwd, [
        "merge-base",
        "--is-ancestor",
        want,
        tip,
      ])
      if (anc.code !== 0) {
        return reject(
          "not-descendant",
          anc.code === 1
            ? `local tip ${tip} does not descend from expected ${want}`
            : `cannot check ancestry of ${want}: ${anc.stderr}`,
        )
      }
    }
    if (before.sha !== want) {
      return { outcome: "head_moved", branch, expected: want, actual: before.sha }
    }

    // 4. Lease push; the lease still guards the race after step 1.
    const push = await git(
      i.cwd,
      buildCasPushArgv({ ...i, remote, localRef: tip }),
    )
    if (push.code === 0) return { outcome: "pushed", branch, from: want, to: tip }

    // 5. Classify against a fresh read of the remote.
    const after = await lsRemote(i.cwd, remote, ref)
    const text = `${push.stdout}\n${push.stderr}`
    if (!after.ok) return reject(failureReason(`${text}\n${after.text}`), text)
    const classified = classifyPush(text, push.code, after.sha, i.expected)
    return { ...classified, branch } as CasPushResult
  }
}
