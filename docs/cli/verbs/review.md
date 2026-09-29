# `agentproto review`

```text
agentproto review run    [--binding <name>] [--cwd <dir>] [--manifest <path>]
                         [--base <ref>] [--head <ref>] [--nocache] [--supersede]
                         [--pr <github-pr-url>] [--headless] [--annotate github]
                         [--json]
agentproto review verify [<attestation.json | dir>] [--cwd <dir>]
                         [--manifest <path>] [--base <ref>] [--head <ref>]
                         [--binding <name>] [--verdict pass|block|incomplete|any]
                         [--if-exported] [--allowed-signers <file>]
                         [--require-signed] [--annotate github] [--json]
agentproto review init   [--cwd <dir>] [--ci github] [--json]
agentproto review key    [show] [--principal <id>] [--cwd <dir>] [--json]
```

CLI surface of the review primitive: a repo's `REVIEW.md` declares check lanes
(command lanes and agent reviewer lanes) and named bindings (`local`, `ci`, …);
a run folds them into a verdict — `pass`, `block`, or `incomplete` — bound to
the manifest sha and the git range in an attestation. The daemon side is the
`review_run` / `review_status` / `review_cancel` / `review_ledger` /
`review_export` / `review_pr` MCP tools.

## Exit codes

Hooks and CI key off these, so a rejection is never confused with a review
that didn't reach a verdict:

| Code | Meaning |
|------|---------|
| `0` | `pass` |
| `1` | `block` — a blocking lane failed |
| `2` | `incomplete` — a lane timed out / was skipped, or the daemon wasn't reachable. **Not** a rejection: fix and retry. |
| `3` | the review could not run (bad `REVIEW.md`, unresolvable range) |
| `6` | signature invalid or missing when `--require-signed` (`verify` only) |
| `64` | usage error |

## `run`

Runs the binding over `merge-base(<target.base>, HEAD)..HEAD` (or
`--base`/`--head`). By default it goes through the local daemon: `review_run`
with `wait: false`, then `review_status` polls until the run settles. Agent
lanes spawn child reviewer sessions and the attestation is written to the
daemon's ledger (`~/.agentproto/reviews`).

| Flag | Description |
|------|-------------|
| `--binding <name>` | Binding to run. Default: the sole binding, or `default`. |
| `--supersede` | Cancel the daemon's in-flight review of an **older head** of the same repo + binding + base (same checkout, or an ancestor head). Cancelled runs record nothing. What a pre-push gate wants. |
| `--pr <url>` | Record the PR (`https://github.com/<owner>/<repo>/pull/<n>`) in the attestation and as the ledger entry's PR link. |
| `--headless` | Run in-process, no daemon: command lanes run; agent lanes settle `skipped`, so a binding with an agent lane is `incomplete`. The CI mode. |
| `--annotate github` | Also print GitHub Actions `::error` / `::warning` lines — `block` and `incomplete` are distinct annotations. |
| `--nocache` | Ignore a cached ledger verdict for the same key. |
| `--json` | Print the run view (+ `exitCode`) as JSON on stdout. |

The requesting session is recorded as `attestation.requester.sessionId` when
`AGENTPROTO_SESSION_ID` is set (MCP callers get their `callerSessionId`), along
with the head commit's author.

## `verify`

Checks an exported attestation against what this checkout sees: the sha of
`REVIEW.md`, the range, the repo remote, internal consistency (range sha, the
verdict re-folded from its lanes) and the verdict (default `pass`). With a
directory — default the manifest's `verdict.exportDir` — it picks the
attestation for the range head, or for `HEAD^` when `HEAD` only adds files
under that directory (committing the export). Exit `0` verified, `1` invalid,
`4` no attestation for the range, `5` (`--if-exported`) no `exportDir` declared,
`6` signature invalid or missing when `--require-signed`.

| Flag | Description |
|------|-------------|
| `--allowed-signers <file>` | SSH `allowed_signers` file to verify the attestation's signature against. Defaults to `.agentproto/allowed_signers` in the repo root when the file exists. An **invalid** signature always exits `6`; a **missing** signature (or no `allowed_signers` file) only exits `6` when `--require-signed` is also set. |
| `--require-signed` | Fail (exit `6`) if the attestation has no signature, instead of accepting unsigned attestations silently. |

## `init`

Wires a repo in, idempotently (a second run reports "already initialized —
nothing to do"):

- `REVIEW.md` at the repo root if absent — one command lane (`<pm> test` when
  `package.json` has a test script, else `git diff --check {base} HEAD`), one
  commented-out agent lane, a `local` binding on pre-push.
- A pre-push hook in `core.hooksPath` (husky's `.husky/_` resolves to
  `.husky`) or git's hooks dir. The gate is a managed script,
  `agentproto-review-pre-push`, called from a marked block in `pre-push`. An
  existing shell hook gets the block **appended** — the original is preserved
  and runs first; a non-shell hook is left alone with instructions. The gate
  runs `agentproto review run --binding local --supersede` over the merge-base
  with the remote's default branch (`AGENTPROTO_REVIEW_BASE` overrides the ref).
  Bypass once with `git push --no-verify`.
- `--ci github`: a `ci` binding and `.github/workflows/review.yml`, which runs
  `review run --headless --binding ci` on `pull_request` and then
  `review verify --if-exported`. An `incomplete` headless run (agent lanes
  can't run in CI) passes only when a verified exported attestation covers the
  PR range; otherwise it fails with a dedicated `review incomplete` annotation.

## `key`

```bash
agentproto review key
agentproto review key show --json
agentproto review key --principal my-team@example.com
```

Prints the daemon install's review signing key: its fingerprint and the
`allowed_signers` line ready to paste into `.agentproto/allowed_signers` (or
pass to `--allowed-signers`). The keypair is generated at
`~/.agentproto/keys/review_ed25519` on first use; it is a shared host file,
not per-daemon state, so this command never requires a running daemon.

| Flag | Description |
|------|-------------|
| `--principal <id>` | Identity claimed in the `allowed_signers` line (default: `git config user.email` in `--cwd`'s repo). |
| `--cwd <dir>` | Repo root for resolving the default principal. |
| `--json` | Emit `{ fingerprint, principal, publicKeyPath, allowedSignersLine }`. |

## Examples

```sh
agentproto review init --ci github
agentproto review run --binding local --supersede
agentproto review run --headless --binding ci --annotate github --pr "$PR_URL"
agentproto review verify --if-exported
agentproto review verify --allowed-signers .agentproto/allowed_signers --require-signed
agentproto review key
```
