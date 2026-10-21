---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/skill-pack-agentproto": minor
---

Let a `prompt-session` cron job target an AGENT LABEL instead of a session id: `action.agent` (or the `agent:<label>` spelling in `sessionId`, from `cron_create` or `agentproto cron add --target-session agent:<label>`). The label is resolved when the job FIRES, not when it is created, so the job survives the target agent being relaunched under a new id (a restart or continue-fresh keeps the label, the id changes). Resolution picks the newest live session with that label (exact, case-insensitive), follows a retired session's successor chain, revives an ended session through the usual restart path, and otherwise fails the tick naming the label; the run result records the session id the label resolved to. Jobs that carry a plain `sessionId` keep working unchanged.
