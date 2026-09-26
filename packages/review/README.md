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
            error?, sessionId?, preset?, summary?, exitCode? }],
  verdict: "pass" | "block" | "incomplete",
  attestor: { daemon, presets },
  rubrics: [{ check, path, sha256 }],   // agent-lane rubric digests
  dirty?: true,                   // tracked changes were present while lanes ran
  createdAt
}
```

`verifyAttestation(att, { manifestSource, baseSha, headSha, verdict: "pass" })`
is the CI check. It recomputes the manifest sha from the REVIEW.md the
verifier sees, compares the range, re-folds the verdict from the lanes (so a
hand-edited verdict is caught), and rejects a dirty-tree attestation.

## Using it from the daemon

`@agentproto/runtime` registers these tools:

| Tool | What it does |
|---|---|
| `review_run({ cwd, manifestPath?, binding?, base?, head?, nocache?, wait? })` | Resolves the range, runs prepare, freezes the range, runs the lanes in parallel, folds the verdict, and writes the ledger. If the ledger already holds a clean `pass`/`block` for the same `(repoRemote, manifestSha, binding, rangeSha)` with matching rubric digests, it returns that with `cached: true`. `wait: false` returns a `runId` right away. |
| `review_status({ runId })` | Polls a run: lanes settled so far, then the attestation. |
| `review_cancel({ runId })` | Cancels a run. Unstarted lanes are skipped, running lanes and reviewer sessions are killed, and the verdict is `incomplete`. |
| `review_ledger({ cwd?, repoRemote?, range?, binding? })` | Lists attestations. `range` is `<base>..<head>` or a rangeSha. |
| `review_export({ runId \| repoRemote+rangeSha, outPath? })` | Writes the standalone attestation JSON. |

```jsonc
// review_run
{ "cwd": "/path/to/repo", "binding": "ci" }
// → { "runId": "review-…", "status": "done", "verdict": "pass", "attestation": { … } }
```

**Agent lanes** run as child reviewer sessions, spawned through the same
`spawnAgentSession` core that `agent_start` uses:

- The lane's `preset` is looked up as a harness preset first, then as a user
  preset.
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
