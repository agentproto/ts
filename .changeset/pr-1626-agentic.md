---
"@agentproto/runtime": minor
---

Add a `jev` config section to the runtime. `jev.apiKey` becomes the primary source for the Jev judge API key (falling back to `JEV_API_KEY` and the host secret resolver), and new `jev.model` / `jev.baseUrl` entries let users pick the judge model and endpoint override; both flow into the session steward's Jev judge tool via the new exported `resolveJevConfig()`.
