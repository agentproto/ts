---
"@agentproto/runtime": patch
---

Make the sandbox preflight a generic yes/no check that a deployment extends from config. `defaults.sandbox.preflight.probes` declares probes as one shell command run in the box (`command`, `okExitCode`, `okStdoutMatches`, `koWhen` patterns with an error class, `failAs`), so "the Zen free model still answers from this IP" or "gh is installed" is a config entry, not code. Each probe now says whether it may run when the spawn carries credentials (`runsWithSpawnAuth`); before, any spawn with auth skipped the whole preflight, so CI's api-key lane never ran its ladder preflight. Probes that need the credential (the built-in `model-answers`) are still skipped, per probe, with a warning.
