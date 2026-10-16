---
"@agentproto/app-kit": minor
---

Add the AIP-53 `services` frontmatter field (`services: [{ name, entry, port? }]`) — an app's production hosting surface, distinct from the dev-only `dev.launch`. `defineApp`, `loadAppHandle` and `emitApp` validate it (non-empty array, unique kebab-case `name`, non-empty `entry`, optional 1..65535 `port`, no extra keys) and carry it verbatim / round-trip it. app-kit never executes a service `entry`: the host spawns one keep-alive service-owner session per entry at install time (later work item), and `dev.launch` remains validation-only.
