---
"@agentproto/runtime": patch
---

`catalog_models` now treats a harness that authenticates itself (its CLI owns the login, no provider and no API key: `copilot-cli`, `antigravity`) as runnable without any auth profile when the caller names that harness. Before, every row was `runnable:false`, so the chat's `runnableOnly` read returned nothing and the model picker stayed empty. `eligibleProfiles` stays empty (pickers show "Harness login"). Global listings and provider-scoped external logins (codex, gemini) are unchanged.
