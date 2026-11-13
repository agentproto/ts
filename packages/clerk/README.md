# @agentproto/clerk

The AIP-68 clerk pass (`clerk/v1`):

- `ClerkHookConfig` and the three-level resolution (agent > workspace > daemon default), disabled by default
- `createClerkTurnEndController`: one debounced, single-flight, fire-and-forget pass per session after a turn ends
- `createClerkPassRunner` / `spawnClerkCommand`: launch the configured AIP-41 routine or an allowlisted command

## What the Clerk is, and is not

The Clerk is the passive trigger: it fires on `session:turn-end`, waits for the
session to be idle (10 minutes by default), then runs one pass. It runs a
routine (`run.routine`) or an allowlisted command (`run.command`). It contains
no model and no classifier.

There is no default `run` (`run: {}`). A Clerk that is enabled with nothing to
run does a clean no-op: no pass is launched, no error is raised, and one info
line (`clerk pass skipped ... run names no routine or command`) says why. Set
`run.routine` or `run.command` to give it work.

Steward is a separate app (`packages/apps/session-steward`: rules, then Jev,
then a judge agent). A Clerk runs it when it is configured with `run.routine`
naming a Steward routine.
