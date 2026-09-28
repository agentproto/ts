---
"@agentproto/runtime": patch
---

Fix `workflow_cancel` crashing the whole daemon when it lands on a run whose agent step is mid-turn: `SessionsRegistryAgentHost.sendPromptAndWait` (and `onAwaitingInput`'s auto-allow branch) now await `registry.sendPrompt` and `waitTurnEnd` together via `Promise.all`, so a session killed mid-turn rejects cleanly instead of producing an unhandled rejection. Also finalizes any step left `running`/`pending` on a persisted terminal (cancelled/failed/done) run found at daemon boot, so a run interrupted mid-finalization no longer reports a stuck step forever.
