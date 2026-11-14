# @agentproto/run

The AIP-58 run substrate (`run/v1`):

- `runWorkspacePaths` / `ensureRunWorkspace`: the host-owned per-run directory layout (`inputs/`, `artifacts/`, `scratch/`), never shared between runs
- `createRunEventLog` / `readRunEvents`: the per-run append-only `events.jsonl` log
- the on-disk run store: one file per run, an in-place lease sidecar, bounded step outputs, and legacy-run migration
- `createFileStepCache`: a journal-file step cache scoped to one cache key
- `WorkflowRun` and the pure stage/step record types the store persists
