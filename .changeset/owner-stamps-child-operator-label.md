---
"@agentproto/runtime": minor
---

`agent_set_operator_label` is no longer refused to every session: a session may stamp the `operatorLabel` of a session it owns (a child it spawned or one of its descendants; the shared `claude-desktop` identity for a child declared under `parent: "cc:<id>"`), so a supervisor can name its children and use `label:<x>` addressing on them. A session still cannot label itself or a session it does not own, and a label already carried by any other non-archived session (live or dead) is refused. A label on a session with a parent is an address only: `allowPromptFrom` `label:` entries, `defaults.tasks.operatorDelegates` and `session-label://` grant principals now match root sessions only.
