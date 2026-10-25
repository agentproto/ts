# @agentproto/clerk

The AIP-68 clerk pass (`clerk/v1`):

- `ClerkHookConfig` and the three-level resolution (agent > workspace > daemon default), disabled by default
- `createClerkTurnEndController`: one debounced, single-flight, fire-and-forget pass per session after a turn ends
- `createClerkPassRunner` / `spawnClerkCommand`: launch the configured AIP-41 routine or an allowlisted command
