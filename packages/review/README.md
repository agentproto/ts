# @agentproto/review

**A review is a workflow with a verdict contract.**

`@agentproto/review` doesn't add an engine. A `REVIEW.md` declares *checks*
and named *bindings*. `compileReview` turns a binding into an ordinary AIP-15
`WorkflowHandle`, and `@agentproto/workflow-runtime` runs it the same way it
runs any other workflow. Three things make it a review:

1. **Verdict schema.** The output is typed: `pass | block | incomplete`, with
   per-lane results and findings that carry a severity.
2. **Attestation.** The verdict is bound to an immutable content range (a git
   sha range) and to the manifest's sha. It's recorded in a daemon-side
   ledger and can be exported as a standalone JSON file for PR provenance or
   CI verification.
3. **Bindings.** Named contexts (`local`, `ci`, …) choose which lanes attest
   and which effectful steps run first.

The package is pure: it parses strings, builds handles, and folds verdicts.
Git, the lane executor, and the ledger belong to the host, which is
`@agentproto/runtime`'s `review_*` tools (see below).

## The compiled workflow

```
prepare-<id>…   kind: gate       sequential, `sh -c <run>` via the engine's gate runner.
                                 Runs BEFORE the range is frozen (it may commit).
freeze          kind: transform  the host resolves head AFTER prepare → ReviewTarget
lanes           kind: parallel   one branch per check; each lane ALWAYS resolves to a
                                 LaneResult (a lane that throws becomes `skipped`)
verdict         kind: transform  fan-in: fold lanes under the binding's quorum
```

The lanes are host-executor `transform` steps, not declarative `gate` or
`agent` steps. A failing `gate` throws, and `parallel` is `Promise.all`, so
one red lane would abort the review and lose every sibling's result. Timeouts
are the other reason: a lane has to report `timeout`, not just `fail`. The
engine still owns sequencing, the parallel fan-out and the fan-in binding.

## Verdict rules

| Lanes | Verdict |
|---|---|
| every **blocking** lane `pass` | `pass` |
| any blocking lane `fail` | `block` |
| otherwise, any blocking lane `timeout` / `skipped` | `incomplete` |

- Anything that didn't run can't pass. A lane that timed out, couldn't spawn,
  never wrote its verdict file, or was cancelled makes the verdict
  `incomplete`.
- Advisory lanes (`blocking: false`) are recorded but never move the verdict.
- A command lane fails on a non-zero exit. An agent lane fails when any
  finding is at or above its `blockOn` severity (`high` > `medium` > `low`).
  Findings below the threshold are kept as advisory.

## REVIEW.md reference

```yaml
---
kind: review                     # required
id: agentproto-ts                # required, kebab-case
name: …                          # optional
description: …                   # optional
target: git-range                # or {kind: git-range, base: origin/main}
                                 # default range: merge-base(<base>, HEAD)..HEAD
checks:
  - id: types                    # kebab-case, unique
    kind: command
    run: "turbo run check-types --filter={changed}"   # sh -c; see placeholders
    cwd: packages/x              # optional, relative to the repo root
    blocking: true               # default true
    timeoutMs: 600000            # default 10 min
    effects: false               # true = mutation-capable → prepare-only
  - id: correctness
    kind: agent
    preset: kimi                 # harness preset id (or a user preset id)
    fallbackPresets: [glm]       # optional; tried in order if the reviewer is UNAVAILABLE
    rubric: ./rubrics/correctness.md   # relative to this REVIEW.md
    blockOn: high                # high | medium | low, default high
    blocking: true               # default true
    timeoutMs: 900000            # default 15 min
bindings:                        # omitted ⇒ implied `default` = every non-effects check
  local: {on: pre-push, prepare: [changeset], checks: [types, correctness]}
  ci:    {on: pr, checks: [build, correctness], quorum: all-blocking-pass}
verdict:
  exportDir: .reviews            # default dir for `review_export` (repo-relative)
---
Free-form markdown: documentation only.
```

These rules are enforced at **parse time**, so a manifest that could produce a
misleading verdict never runs:

- A binding may only reference declared checks. An unknown ref is an error.
- An `effects: true` check may appear only in a binding's `prepare` phase,
  never as an attesting lane. A `prepare` entry has to be an `effects: true`
  check, and agent checks can't set `effects`.
- Every binding must select at least one blocking check. A binding that can
  never block would attest nothing.
- `fallbackPresets` may not repeat a preset or name the check's own `preset`.
  On a `uses[]` entry (or `overrides.<id>`) it sets the chain for imported
  agent checks, checked when `resolvePacks` resolves the final `preset`.

### Placeholders

A command's `run` line can carry `{name}` placeholders. The mechanism is
generic: `{identifier}` is replaced by a bound value, and an unbound
placeholder is a compile error, never a silent literal. Shell syntax is left
alone: `${VAR}`, brace expansion like `{a,b}`, and the escaped literal
`{{name}}`.

| Placeholder | Bound by | Value |
|---|---|---|
| `{base}` | host (prepare), compiler (lanes) | range base sha |
| `{head}` | compiler, **lanes only** | frozen head sha (prepare runs before the freeze) |
| `{changed}` | daemon host | `'[<baseSha>]'`, a shell-quoted turbo filter for packages changed in the range. Use `...{changed}` to include dependents. |

## Review packs

A review pack is an installable, pinned, reusable bundle of checks +
rubrics — a repo `uses:` it instead of hand-writing the same rubrics every
repo already has (correctness, security, …). `@agentproto/review-pack-core`
ships three of them.

**Pack format.** A pack is a directory whose own `REVIEW.md` declares
`kind: review-pack`, `id`, `version` (semver), `description`, and `checks[]`
in the normal check syntax — nothing else. A pack declares NO `bindings`, NO
`prepare`, and NO `effects: true` check (each is a `parsePackManifest` error): a pack is
checks + rubrics, never a workflow of its own. An agent check inside a pack
may OMIT `preset` — presets are host-specific, so the consumer supplies one.
Rubric paths are relative to the pack's own root.

```yaml
---
kind: review-pack
id: core
version: 1.0.0
description: Generic correctness + security lanes.
checks:
  - {id: correctness, kind: agent, rubric: ./rubrics/correctness.md, blockOn: high}
  - {id: security, kind: agent, rubric: ./rubrics/security.md, blockOn: high}
---
```

**Consumption.** A top-level `uses:` in the CONSUMER's REVIEW.md:

```yaml
uses:
  - pack: "@agentproto/review-pack-core"   # npm name | ./relative/path | git+https://...#<40-hex sha>
    as: core                               # namespace — the pack's checks become core/<id>
    checks: [correctness, security]        # optional subset; default all
    preset: cc-subs-agentik                # default preset for the pack's agent checks
    fallbackPresets: [opencode-default-go] # optional: reviewers tried if the preset's is unavailable
    overrides:                             # optional per-check field overrides (by the pack's own id)
      security: {blockOn: medium, timeoutMs: 600000}
    allowCommands: false                   # see Security, below
checks: [...]
bindings:
  local: {on: pre-push, checks: [types, core/correctness, core/security]}
```

A pack's imported checks are namespaced `<as>/<id>`; a binding references
them like any other check. A manifest that declares `uses[]` must declare
its bindings explicitly — the implied `default` binding only knows LOCAL
checks, and silently excluding every pack check that way would be exactly
the kind of misleading-verdict trap this package's parse-time validation
exists to catch. An agent check that still has no `preset` after `overrides`
and `uses[].preset` (and none in the pack itself) is an error naming the
check, raised by `resolvePacks` (a `ReviewManifestError`) — not by
`parseReviewManifest`, which has not loaded the pack yet.

**Resolution.** `resolvePacks(manifest, loader)` is the pure package's half
of this — it merges a manifest's `uses[]` in, given an injected
`PackLoader` (the "host seam, not the pure package" the frozen design
calls for; a no-op when `uses` is empty, so a caller can always call it
unconditionally). The daemon's loader
(`@agentproto/runtime`'s `createReviewPackLoader`) resolves:

- a relative path (`./…`, `../…`, or absolute) — resolved against the
  CONSUMER REVIEW.md's own directory. Resolving is NOT the same as being
  trusted — see Security, below.
- an npm package name — resolved from the reviewed repo's root via Node's
  own module resolution (`node_modules`, no network, no install);
- `git+https://...#<sha>` — `https://` ONLY (ssh://, file://, ext::, and
  plain http:// are all rejected — `ext::` in particular can run an
  arbitrary local command), pinned to a full 40-hex commit sha ONLY; a
  floating ref (branch, tag, short sha) is rejected at parse time —
  reproducibility first. Cloned once into
  `~/.agentproto/review-packs/<sha>/` and reused from there; the URL is
  passed to `git clone` after a literal `--`, so it can never be misread as
  a flag.

**Identity + cache.** Each resolved pack gets a digest: sha256 over its
REVIEW.md plus every rubric file its SELECTED checks use (sorted by path).
The attestation gains `packs?: [{ref, id, version, alg, sha256}]` —
additive, the attestation schema id is unchanged, and the digest lives
inside the signed bytes automatically (nothing special to wire up). A
ledger cache hit requires identical pack digests, exactly like rubric
digests: edit one rubric a pack's checks use, or the pack's own REVIEW.md,
and the next run misses the cache. Attestation composition (delta
re-review, see `packages/runtime/src/review-compose.ts`) extends the same
way — a lane whose check came from a pack composes only onto a prior
attestation that carries an IDENTICAL digest for that pack, not just a
matching digest for the lane's own rubric file (a change elsewhere in the
pack — another check's config, the pack's own REVIEW.md — can change what
this check's config resolves to even when its own rubric file didn't
move).

`alg` names the digest RECIPE (not the hash function — that's always
sha256): which bytes get hashed, in what order, with what separators. It
travels inside a *signed* attestation, so it's versioned from day one even
though only one version exists — `agentproto-pack-digest/v1`
(`PACK_DIGEST_ALG`, `computePackDigestSha256` in `packages/review/src/packs.ts`).
Exact byte layout, reproducible from raw files with no need to re-run
`resolvePacks`:

1. One line per input: the REVIEW.md source gets the literal label
   `"REVIEW.md"`; each SELECTED rubric gets the check's own `rubric` path
   exactly as declared on the pack (relative to the pack root, not
   namespaced). A line is `<label>\0<sha256-hex-of-that-input's-raw-bytes>`
   — a NUL separator, not `:` or whitespace, since a label could legally
   contain either.
2. Lines sorted lexicographically (stable regardless of `checks:` subset
   iteration order).
3. Lines joined with `"\n"`, no trailing newline.
4. The joined string is UTF-8-encoded and sha256'd; the digest is the
   lowercase hex of that hash.

`review verify` checks `alg` BEFORE comparing `sha256`: an attestation
whose `alg` this checkout's `resolvePacks` doesn't recognize is a hard
verify FAILURE, not a soft "can't check" note — comparing hex digests
computed under two different, unstated recipes as if they meant the same
thing is exactly the mis-verify a versioned `alg` exists to rule out.

**Security.** A pack's `command` checks run shell commands in the
CONSUMER's checkout — third-party code execution. `resolvePacks` rejects
them (a `ReviewManifestError`, not a `parseReviewManifest` one — the pack isn't
loaded until then) unless the `uses` entry sets `allowCommands: true`. A relative-path pack is
exempt — but "the ref string looks relative" is never enough by itself:
the loader only exempts a relative pack whose resolved root (realpath'd,
so a symlink can't point outside and still count) sits INSIDE the reviewed
repo root AND whose REVIEW.md is tracked by git there. A `../..` escape, an
absolute path elsewhere, or an untracked in-repo directory (a gitignored
scratch dir, `./node_modules/<pkg>`) all still LOAD — they're just not
exempt, same as an npm or git pack. An npm or git pack's command checks are
never exempt, full stop.

A pack check's `rubric` field is untrusted input too (the pack author's,
not the consumer's) — the loader refuses to read outside the pack's own
root, realpath'd on BOTH sides so neither a `../../..` escape, an absolute
path, nor a same-directory symlink pointing elsewhere can smuggle out
content from anywhere else on disk (`~/.ssh`, `/etc/passwd`, …) into the
pack digest or the reviewer's prompt. This applies to every pack —
including a trusted, same-repo one; there's no legitimate reason a pack's
own rubric needs to live outside it. Checked once, at `resolvePacks` time
(before any lane runs), so a violating pack never reaches a reviewer
session at all — the whole review fails with a clear error naming the
check instead.

Rubric confinement is a PACK rule only: a check declared directly in a
REVIEW.md may point its `rubric` anywhere (relative to that REVIEW.md's
directory) — local rubric paths are unconfined, pack rubric paths are
confined to the pack root.

**Git pins.** A git pack ref is `git+https://<url>#<40-hex-sha>` and nothing
else (no ssh, file, ext or plain http; no floating branch, tag or short sha).
The pin starts at the FIRST `#`, so the url contains neither `#` nor
whitespace — the same shape `REVIEW.schema.json` accepts. `parseGitPackRef`
is the one parser the manifest and the daemon's pack loader both use.

**Verify.** `review verify` re-checks `packs[]` digests against what THIS
checkout's `uses[]` resolves to RIGHT NOW, but only when every pack
actually resolves locally — an unresolvable pack (offline, not installed,
the git cache missing) is a reported note, never a verify failure. A digest
that DOES resolve and mismatches is a real failure: the pack's content
changed since the attestation was produced.

**Scaffolding.** `agentproto review init --pack <ref> [--as <ns>]` adds a
`uses:` entry to REVIEW.md (creating the file first if absent) —
idempotent by `pack` ref; a second `--pack` with the same ref is a no-op
regardless of `--as`.

## Full example

[`examples/REVIEW.md`](./examples/REVIEW.md), which the tests exercise:

```yaml
---
kind: review
id: agentproto-ts
target: {kind: git-range, base: origin/main}
checks:
  - {id: types, kind: command, run: "turbo run check-types --filter={changed}"}
  - {id: changeset, kind: command, run: "pnpm changeset:auto", effects: true}
  - {id: build, kind: command, run: "turbo run build --filter={changed}"}
  - {id: correctness, kind: agent, preset: kimi, rubric: ./rubrics/correctness.md, blockOn: high}
bindings:
  local: {on: pre-push, prepare: [changeset], checks: [types, correctness]}
  ci:    {on: pr, checks: [build, correctness]}
verdict:
  exportDir: .reviews
---
```

## Attestation

```ts
{
  schema: "agentproto.review.attestation/v1",
  runId, reviewId, manifestSha, binding,
  target: { repoRemote, baseSha, headSha },
  rangeSha,                       // sha256("<baseSha>..<headSha>")
  lanes: [{ id, kind, status: "pass"|"fail"|"skipped"|"timeout", blocking,
            findings: [{ severity, title, detail, file?, line? }], durationMs,
            error?, sessionId?, preset?, fallbacks?: [{ preset, error }],
            summary?, model?, exitCode?,
            composedFrom?: { rangeSha, headSha, attestationSha256 } }],  // delta-composed agent lane
  verdict: "pass" | "block" | "incomplete",
  attestor: { daemon, presets, signature?: { alg: "ssh-ed25519", keyFingerprint,
              principal, signedAt, sig } },   // signed by the daemon's key — see `agentproto review key`
  rubrics: [{ check, path, sha256 }],   // agent-lane rubric digests
  packs?: [{ ref, id, version, alg, sha256 }],   // resolved uses[] pack digests — see Review packs
  dirty?: true,                   // tracked changes were present while lanes ran
  requester?: { sessionId?, gitAuthor?: { name, email } },   // who asked; not authenticated
  pr?: { provider: "github", repo, number, url },
  createdAt
}
```

`verifyAttestation(att, { manifestSource, baseSha, headSha, verdict: "pass" })`
is the CI check. It recomputes the manifest sha from the REVIEW.md the
verifier sees, compares the range, re-folds the verdict from the lanes (so a
hand-edited verdict is caught), and rejects a dirty-tree attestation.

**Signing.** The daemon signs each attestation with an ssh-ed25519 key
(namespace `agentproto-review`, generated at `~/.agentproto/keys/review_ed25519`
on first use; `agentproto review key` prints the fingerprint and an
`allowed_signers` line). `review verify` checks the signature against
`.agentproto/allowed_signers` (or `--allowed-signers`); an invalid signature is
always exit 6, a missing one only with `--require-signed`.

**Composition.** With `compose` (default on), an agent lane can reuse a prior
passing attestation from the daemon's OWN ledger and review only the delta
above that attestation's head. The prior must be the same repo, binding,
manifest sha and lane rubric digest, have the same base and a head that is a
strict ancestor of the new head, be `pass` (verdict and that lane) and not
`dirty` — and, for a pack check, carry an identical pack digest. The lane
records `composedFrom` pointing at the prior attestation. Command lanes are
never composed; `nocache` implies `compose: false`.

## Using it from the daemon

`@agentproto/runtime` registers these tools:

| Tool | What it does |
|---|---|
| `review_run({ cwd, manifestPath?, binding?, base?, head?, nocache?, compose?, wait?, requesterSessionId?, pr?, supersede? })` | Resolves the range, runs prepare, freezes the range, runs the lanes in parallel, folds the verdict, and writes the ledger. If the ledger already holds a clean `pass`/`block` for the same `(repoRemote, manifestSha, binding, rangeSha)` with matching rubric digests, it returns that with `cached: true`. `compose` (default true) lets agent lanes review only the delta over a prior passing attestation. `requesterSessionId` (default: the calling session) is recorded as `attestation.requester.sessionId`; `pr` records the GitHub PR; `supersede` cancels in-flight reviews of an older head of the same repo + binding + base. `wait: false` returns a `runId` right away. |
| `review_status({ runId })` | Polls a run: lanes settled so far, then the attestation. |
| `review_cancel({ runId })` | Cancels a run. Unstarted lanes are skipped, running lanes and reviewer sessions are killed, and the run ends `cancelled`: NO verdict and no attestation are recorded (the CLI exits `2`). |
| `review_ledger({ cwd?, repoRemote?, range?, binding? })` | Lists attestations. `range` is `<base>..<head>` or a rangeSha. |
| `review_export({ runId \| repoRemote+rangeSha, outPath? })` | Writes the standalone attestation JSON. |
| `review_pr({ runId? \| rangeSha? \| range? \| cwd? \| prUrl? })` | Follows a recorded review to its GitHub pull request (via the host's `gh`), records the link, and appends a PR-state snapshot to the ledger entry's annotations — never to the attestation. |

```jsonc
// review_run
{ "cwd": "/path/to/repo", "binding": "ci" }
// → { "runId": "review-…", "status": "done", "verdict": "pass", "attestation": { … } }
```

**Agent lanes** run as child reviewer sessions, spawned through the same
`spawnAgentSession` core that `agent_start` uses:

- The lane's `preset` is looked up as a harness preset first, then as a user
  preset.
- If the reviewer is unavailable — spawn failure, a turn that ends in an
  error, an empty turn, or a session that exits early — the lane moves on to
  the next entry of the check's `fallbackPresets` (per-preset retries first;
  one shared `timeoutMs` deadline). It never falls back after a verdict
  (a `block` is final), a timeout, a cancel, or an OpenRouter refusal. The
  lane's `preset`/`model`/`sessionId` name the reviewer that ran, and
  `fallbacks` records each unavailable one with its error. An exhausted chain
  settles the lane `skipped`, listing every error.
- The reviewer spawns with role `executor`, under the calling session.
- It gets a pointer-style prompt: the range plus the rubric path. There's no
  serialized diff, so there's no diff cap.
- It writes its verdict JSON to a file under the ledger's run directory,
  outside the reviewed tree.
- On timeout or cancel it's killed through the normal session lifecycle.

**The ledger** lives at
`~/.agentproto/reviews/<repo-slug>/<manifestSha>/<binding>/<rangeSha>.json`
and never in the reviewed repo. Every attestation is recorded, but only a
clean `pass`/`block` is ever served back as a cache hit.

## License

Apache-2.0
