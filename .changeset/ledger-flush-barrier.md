---
"@agentproto/runtime": patch
---

The workflow runner no longer reports a run as finished while one of its app-ledger writes is still in flight. The app-state ledger is a SEPARATE async chain from the run files, so a terminal `status()` could be observed while the last `stage-done`/`blocked` append was still pending — a caller that then tore the app's `data/state` dir down raced that append's `mkdir`/`open` into it, which showed up as an intermittent `ENOTEMPTY` (the flaky `app-boundary-workflow` test). The runner now drains the ledger queue BEFORE publishing the terminal status, so "terminal" always means "this run's ledger writes have landed"; `runner.flush()` also drains the queue of every still-running app-backed run, making it a complete barrier for shutdown paths.
