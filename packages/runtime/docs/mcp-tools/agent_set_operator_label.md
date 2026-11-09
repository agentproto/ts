# agent_set_operator_label

Stamp (or clear) a session's `operatorLabel`: the stable name that
`message_send to:"label:<x>"` and `agent_prompt` / `agent_interrupt` /
`agent_kill` with `id:"label:<x>"` resolve to the ONE live session carrying it.
A killed or retired session never matches.

```json
{ "sessionId": "sess_8ad199ca", "operatorLabel": "linkedin-scout" }
```

Result: `{ "ok": true, "sessionId": "...", "operatorLabel": "linkedin-scout" }`
(`null` once cleared). Surrounding whitespace is trimmed; `""` or whitespace
clears the label.

## who may call it

| Caller | Target | Result |
|---|---|---|
| human operator (no caller session) | any session | allowed |
| a session | a session it OWNS: one it spawned, or a descendant of it | allowed |
| the shared `claude-desktop` identity | a child spawned with `parent: "cc:<id>"` that still carries the default `claude-desktop` entry in `allowPromptFrom` | allowed |
| a session | itself | refused |
| a session | a session it does not own | refused |

Ownership is the one the drive gate uses for `agent_prompt` (parent, then the
`parentSessionId` chain), without its `allowPromptFrom` grants: being allowed to
prompt a session is not owning it, so a grant holder cannot name the session.
The `claude-desktop` row exists because a child declared under `cc:<id>` has an
owner no Desktop call can present; the recorded `claude-desktop` grant is the
daemon's proof that this identity spawned it.

## uniqueness

A session caller is refused when ANY other non-archived session already
carries the label, live or not: `exited`, `killed`, `error` and retired rows
count. The error names the holder and its status. A dead holder keeps its name
because it is expected back: a brain labelled `pygmalion-brain-persistent` that
is down between two restarts takes the label again on rebirth, and a child
that grabbed it meanwhile would receive the brain's `label:` messages and then
turn the address into `ambiguous_label`. Archive the dead session
(`session_archive`) to free its name. A predecessor of the target itself (its
restart / continue-fresh chain ends at the target) is the same lineage, not a
holder, and re-stamping a session with the label it already has is a no-op.
The human operator is not subject to this check (it can deliberately share a
label, in which case `label:<x>` answers `ambiguous_label`).

## a label is an address, never a grant

A label stamped on a session that has a parent only lets others find it. These
surfaces match root sessions (no parent) only:

- `label:<x>` / `label:<prefix>*` entries in another session's `allowPromptFrom`;
- `defaults.tasks.operatorDelegates` `label:` entries;
- `session-label://<x>` principals in `defaults.messaging.grants`.

So a supervisor labelling its child can never give that child a grant it did
not already have. A session's own `session_rename` label never matches any of
them either.

## when to use it

- A supervisor naming the children it launches, so it (or a peer) can address
  them by name across a restart that changes their session id.
- The operator labelling a root lineage that has lived by resume/continue-fresh
  since before it got a label, so there was nothing to carry forward.
