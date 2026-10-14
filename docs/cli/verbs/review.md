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
agentproto review init   [--cwd <dir>] [--ci github] [--pack <ref> [--as <ns>]] [--json]
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
| `2` | `incomplete` — a lane timed out / was skipped, or the daemon wasn't reachable. **Not** a rejection: fix and retry. A run cancelled by `--supersede` (or `review_cancel`) records no verdict or attestation at all and also exits `2`. |
| `3` | the review could not run (bad `REVIEW.md`, unresolvable range) |
| `4` | no attestation for the range (`verify` only) |
| `5` | `--if-exported` and the manifest declares no `verdict.exportDir` (`verify` only) |
| `6` | signature invalid, or missing when `--require-signed` (`verify` only) |
| `64` | usage error |

### Transient reviewer errors

An agent lane whose reviewer turn ends in a transient error (a dropped socket,
a 5xx, an overloaded provider) is retried once, in a fresh reviewer session
that shares the lane's `timeoutMs`. Credential, quota and unknown-model errors
are never retried. Set `review.laneRetries` in the daemon config (`0`
disables, max 5; default 1). A lane that still fails settles `skipped` with
the adapter's own error text and the attempt count.

### Reviewer fallback (`fallbackPresets`)

An agent check may list `fallbackPresets: [<preset>, …]` next to its `preset`
(also accepted on a `uses[]` entry and in `uses[].overrides.<id>`; an
override replaces the `uses[]` value). When the reviewer is **unavailable** the
lane runs on the next preset in `[preset, ...fallbackPresets]`, in order;
the per-preset retries above run on each one first, and the whole chain shares
the lane's single `timeoutMs` deadline.

"Unavailable" is transport-class only: a spawn failure, a turn that ended in
an error (including quota or auth errors), an empty turn, or a reviewer
session that exited before finishing. It **never** falls back after a
reviewer produced a verdict (a `block` from any reviewer is final), a
timeout, a cancel, an unknown preset, or an unreadable verdict file. OpenRouter
stays refused: a refused preset is not skipped over, and listing an OpenRouter
preset in `fallbackPresets` fails that step closed — nothing is ever added to
the chain implicitly.

The lane's `preset`, `model` and `sessionId` name the reviewer that actually
produced the verdict; each unavailable one before it is recorded with its
error in the lane's `fallbacks: [{ preset, error }]` and shown in the `review`
output (`[kimi/…] after glm unavailable`). If every preset in the chain is
unavailable the lane settles `skipped` (verdict `incomplete`) and its error
lists each preset tried with its error. A preset may appear only once in
`[preset, ...fallbackPresets]` — a duplicate is a manifest error.

### Verdict recovery (`review.recoveryPresets`)

A reviewer is told its verdict **is** the file it writes. When its turn ends
and that file is missing or fails `parseAgentLaneReport`, the review workflow
runs one bounded, passive recovery step before the reviewer session is torn
down — not a standalone watcher, and not a second review. Nothing below runs
unless `review.recoveryPresets` is configured (unset it to roll back). The
ladder, most trustworthy first:

1. **Deterministic extraction (no model call).** The daemon reads the
   reviewer's typed transcript (`events.jsonl`: assistant `text-delta` records
   only — never tool calls, tool results, thoughts or flattened output lines)
   and, if the reviewer itself stated exactly one complete, schema-valid
   verdict as JSON in its final message, writes it verbatim. `recovery.outcome`
   is `recovered`, `reason` says it was extracted, and no recovery
   `sessionId`/`preset`/`model` is recorded. Not accepted: a verdict copied
   from tool/repo output, the prompt's own `<one line>` template, an
   incomplete or self-contradictory verdict, an approval from a turn that
   ended in an error, or two different verdicts (a conflict). If the
   transcript or its `turn-end` record is unavailable, provenance cannot be
   established and nothing is extracted.
2. **One small recovery model step** — the first usable preset in
   `review.recoveryPresets` (daemon config), with the `review.recovery` model
   role overriding its model/auth profile when set. It sees only the
   reviewer's own assistant text plus lifecycle/error evidence (bounded; an
   empty scratch cwd, read-only posture). It is a full model-harness session:
   the prompt asks for no tools, which is an instruction, not enforcement. It
   answers `recovered`, `needs_followup`, `insufficient_evidence` or
   `reviewer_failed`, and it **can never approve**: an approval, a
   `request_changes` without a finding at or above the lane's `blockOn`, or
   prose alone is rejected. A `recovered` reply may only lift findings the
   reviewer explicitly reported: each title (and detail) must be copied
   verbatim from the reviewer's prose, the file must appear there as the full
   path, the line number and the severity must be stated next to it, and the
   daemon replaces the model's summary. Anything unsupported rejects the whole
   reply (`invalid_output`).
3. **One follow-up to the original reviewer** (`needs_followup`, or
   conflicting chat verdicts), then the file is re-checked (a verdict stated
   in the follow-up's chat is extracted the same way). This is the only path
   to an approval that was not written to the file, and it is the original
   reviewer's own. A follow-up turn that errors never earns an approval (an
   approval it wrote is removed) and its error text is kept in `reason`.

At most one recovery model step and one follow-up per reviewer execution (a
shared execution recovers once), all inside the lane's original `timeoutMs`
deadline; cancel is honored throughout. A report recovered from a turn that
ended in an error keeps the provider's error text in `recovery.reason`.
OpenRouter stays refused for the recovery step too.

The lane keeps the reviewer's own provenance and records the recovery apart:
`recovery: { outcome, reason?, sessionId?, preset?, model? }`. With no
recovery preset configured, nothing changes: a missing verdict file fails the
lane as before.

### Shared fallback executions

Within one run, lanes whose fallback chains resolve to the same reviewer —
same actual adapter/model/auth profile, same rubric bytes, same effective
frozen git range (a composed delta base counts as its own range) and same
check options — share **one** reviewer execution. The claims rubric is a
different rubric and never shares with correctness. Sharing is scoped to the
run; a later run starts fresh.

Every participating lane records `sharedExecution: { executionId, role:
"owner"|"joiner", ownerLane }`: lanes with one `executionId` are one
reviewer's verdict, not independent agreement. A joiner never extends the
owner's deadline and stops waiting at its own; the execution is cancelled only
when every participant has left. Cooldowns, the OpenRouter guard and delta
composition are the existing mechanisms and apply unchanged. A settled
success is kept for later lanes of the run; a failure or timeout is shared
with the lanes already waiting and then forgotten, so a later lane retries for
itself.

## `run`

Runs the binding over `merge-base(<target.base>, HEAD)..HEAD` (or
`--base`/`--head`). By default it goes through the local daemon: `review_run`
with `wait: false`, then `review_status` polls until the run settles. Agent
lanes spawn child reviewer sessions and the attestation is written to the
daemon's ledger (`~/.agentproto/reviews`).

| Flag | Description |
|------|-------------|
| `--binding <name>` | Binding to run. Default: the sole binding, or `default`. |
| `--supersede` | Cancel the daemon's in-flight review of an **older head** of the same repo + binding + base on the same line of work (same checkout, or the same branch name with an ancestor head). Sibling and stacked branches in other worktrees are never cancelled. Cancelled runs record nothing. What a pre-push gate wants. |
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
- `--pack <ref> [--as <ns>]`: adds a `uses:` entry for a review pack to
  `REVIEW.md` (creating the file first if absent), namespaced `<ns>` (default:
  derived from the ref). Idempotent by `pack` ref — a second `--pack` with the
  same ref is a no-op regardless of `--as`. A git ref must be
  `git+https://<url>#<40-hex-sha>`; the pin starts at the FIRST `#`.
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
