# sandbox_checkpoint_gc

Reclaim stale `agentproto-checkpoint/*` branches from a workspace remote.

A sandbox session snapshots its uncommitted work onto
`agentproto-checkpoint/<work-branch>` (see
`packages/runtime/src/sandbox-delivery.ts`). When a box dies with uncommitted
work still on it, that ref survives as the only copy of the work; once the
session's PR merges/closes — or the snapshot's content lands in the work
branch or the base branch — the ref is dead weight. Dozens accumulate. This
tool sweeps them, using the same engine as
`agentproto sandbox checkpoint-gc`.

**Dry run is the default.** `apply: true` deletes only refs the engine can
prove `safe`, and it re-lists and re-classifies every ref in a fresh plan
immediately before deleting it — a plan that went stale between plan and
apply deletes nothing.

## Classification

Each ref is judged on the snapshot's content (its tree), never on ancestry
alone:

| Verdict | Meaning |
|---|---|
| `safe` | The rescued work is provably elsewhere: the work branch's PR is merged/closed, the snapshot's tree is verbatim the work branch's or base's tree, the parent landed and the snapshot was clean, or the parent's commits squash-/patch-merged into base. |
| `keep` | No proof. A dead box's checkpoint may be the only copy of its work, so the tool never guesses against keeping it. |
| `unknown` | The ref's objects could not be fetched, or there is no resolvable base to adjudicate against. Never deleted. |

## Inputs

| Input | Default | Description |
|---|---|---|
| `repoRoot` | — | Absolute path to the git repo. Wins over `workspaceSlug`. |
| `workspaceSlug` | active workspace | Workspace slug from `agentproto workspace list`. |
| `remote` | `origin` | Remote to sweep. |
| `base` | repo's detected default branch (`origin/<default>`) | Content adjudication base. |
| `apply` | `false` | Execute the fresh plan and delete `safe` refs. |
| `wait` | `true` | Block until done. `false` returns a `jobId` immediately. |
| `waitMs` | — | Block at most this long, then fall back to background (returns `{ jobId, status: "running" }`). |

## Result

A dry run returns `{ mode: "plan", plan, summary }`; an apply returns
`{ mode: "apply", plan, summary, outcomes, applySummary }`.

`summary` tallies `{ total, safe, keep, unknown }`. `applySummary` tallies
`{ status, deleted, skipped, failed }` where `status` is `ok`, `partial`,
`failed`, or `noop`. The full result is always saved to disk.

## Polling

A sweep can outlast an MCP caller's timeout. Pass `wait: false` (or
`waitMs`) and poll `sandbox_checkpoint_gc_status` with the returned `jobId`
about every 30 seconds. When done it returns the same `summary` (plus
`applySummary` on an apply) and the `resultPath` of the full result on disk;
the result file also survives a daemon restart.
