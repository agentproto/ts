---
"@agentproto/apps": patch
"@agentproto/cli": minor
"@agentproto/runtime": minor
"@agentproto/worktree": minor
---

Let an operator approve a guard-refused branch verdict without retyping it.

- New `agentproto branch gc approve <sha|branch>... --by <name> [--note <text>] [--repo <dir>] [--dry-run] [--json]`. It copies the stored verdict for each tip and adds `operator: { by, note }`. It refuses, and records nothing, when no verdict is stored, the stored `gate.agree` is not true, no ref named in the verdict still points at its sha, or `--by` is the reviewer.
- The approval goes through the new daemon route `POST /branches/gc/approve`. The route accepts only `Authorization: Bearer <per-boot token>` (no loopback bypass, no allowlisted Origin, no `?token=`) and refuses any request carrying a session identity (a session token or a caller-session claim). The CLI forwards `$AGENTPROTO_SESSION_ID`, so the command is refused from inside an agent session. The existing `branch_gc_verdict` session refusal is unchanged.
- `@agentproto/worktree` exports `approveBranchVerdict`; `@agentproto/runtime` exports the `BranchGcOperatorApprover` port (`approveBranchGcVerdict` in `createGateway`).
- The repo-maintenance `maintain` report prints one `agentproto branch gc approve <sha> --by <your name>` command per queued tip instead of a JSON template, and counts and lists the decision queue and the reviewed-reclaimed list once per tip sha, with the ref kinds on one line.
