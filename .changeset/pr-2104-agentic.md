---
"@agentproto/cli": patch
---

Move the `adapter-pi` truncate regression test into its own file (`resolve.transient.test.ts`) so it runs under a fresh ESM module registry, avoiding the order-dependent failure caused by `pi` being imported earlier in `resolve.test.ts`. Test-only change; no production behavior change.
