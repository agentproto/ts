---
"@agentproto/runtime": patch
---

`agentproto sandbox egress-health --probe` now boots its per-slot probe boxes in parallel (1 CPU, 1 GiB, with the egress hosts opencode needs, `models.dev` included) instead of one after another with the template default size, and a `model-answers` timeout with no output is reported as unknown with a hint to re-run opencode with `--print-logs --log-level WARN`, since opencode retries rate limits silently.
