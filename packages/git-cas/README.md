# @agentproto/git-cas

Compare-and-swap `git push`: update `refs/heads/<branch>` on a remote only if
it still points at the SHA your work is based on. Zero runtime dependencies
(node builtins and the `git` binary).

A plain `git push` already refuses a non-fast-forward, but it succeeds
whenever your commit happens to sit on top of a head someone else moved: a fix
computed for A lands on top of a human's B. `casPush` rejects that as
`head_moved` and never pulls, rebases or retries.

```ts
import { casPush } from "@agentproto/git-cas"

const r = await casPush({ cwd, branch: "my-pr", expected: { sha: reviewedSha } })
if (r.outcome === "head_moved") {
  // someone else pushed r.actual; park the work, do not re-apply it
}
```

Repo scripts and workflow entries import the built file by relative path,
`packages/git-cas/dist/index.mjs`.

## API

```ts
type CasExpected = { sha: string } | { absent: true }

interface CasPushInput {
  cwd: string
  remote?: string     // default "origin"
  branch: string      // refspec <localRef>:refs/heads/<branch>
  expected: CasExpected
  localRef?: string   // default "HEAD"
  noVerify?: boolean  // default false
}

type CasPushResult =
  | { outcome: "pushed"; branch: string; from: string | null; to: string }
  | { outcome: "noop"; branch: string; sha: string }
  | { outcome: "head_moved"; branch: string; expected: string | null; actual: string | null }
  | { outcome: "rejected_other"; branch: string;
      reason: "not-descendant" | "protected" | "hook-declined" | "auth" | "network" | "unknown";
      detail: string }

buildCasPushArgv(i): string[]      // pure: git args for the lease push
buildCasPushCommand(i): string     // pure: same, as one shell-quoted command line
classifyPush(porcelain, exitCode, actualAfter, expected): CasPushResult  // pure
casPush(i, { log? }): Promise<CasPushResult>
CAS_STOP_RULE                      // the stop sentence for box prompts
```

`expected.sha` must be a full object id. `casPush` steps:

1. Resolve the local tip; read the remote tip with `ls-remote`.
2. Remote already equals the tip: `noop` (covers a re-run of the same push).
3. Preconditions, no network write: with `{sha}`, a tip that does not descend
   from `expected` is `rejected_other/not-descendant`; a remote tip other than
   `expected` (or any tip with `{absent}`) is `head_moved`.
4. `git push --porcelain [--no-verify] --force-with-lease=refs/heads/<b>:<expected|""> <remote> <tip>:refs/heads/<b>`.
   The lease still guards the race after step 1.
5. Exit 0 is `pushed`. Otherwise re-read the remote: moved is `head_moved`,
   else `protected`, `hook-declined`, `auth`, `network` or `unknown`.
6. Never retries, fetches or rebases.

Each call prints one JSON line (to stdout, or to `opts.log`):
`{event:"git_cas_push", outcome, reason?, remote, branch, expected, actual, to, detail?, durationMs}`.
Credentials in URLs are stripped and `detail` is capped at 2 KiB.

## CLI

```sh
agentproto-git-cas push --branch <b> (--expect <sha> | --expect-absent) \
  [--remote <name|url>] [--local-ref <ref>] [--cwd <dir>] [--no-verify]
```

Prints the result JSON on stdout (the log line goes to stderr). Exit `0`
pushed/noop, `3` head_moved, `4` rejected_other, `2` usage error. The package
writes no CI outputs, step summaries or comments.

## Tests

The suite uses real git against scratch bare repos under `os.tmpdir()`.
`GIT_CAS_IMPL=plain pnpm test` runs the `casPush` cases against a plain
`git push` stub (`src/plain-push-stub.ts`); every one of them fails there.
