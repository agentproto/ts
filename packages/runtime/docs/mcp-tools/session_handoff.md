# session_handoff

Hand a session's work to another **model** and/or **harness**. It works on
yourself: omit the session ref and the caller is the source ("I'm a Sonnet
session, pass me to Fable").

The successor is a new session that takes over the source's label, parent,
operator label, pin, live children and follows, and the declared succession
(`succeeds` / `succeededBy`, see `lineage-handover.md`). The source is closed
(reason `restarted`) only after the successor is confirmed `running`; if it
never starts, the source is left alone and a warning says so. When the source is
the caller, it is closed ~2 s after the result returns, so the result reaches
you.

```jsonc
// "I pass the hand to Fable", on myself
{ "tool": "session_handoff",
  "arguments": {
    "model": "claude-fable-5-2",
    "notes": "Goal: ... Done: ... Next step: ... Decisions: ..."
  } }
```

## context

| value | what travels | new session? |
| --- | --- | --- |
| `handoff-summary` (default) | Structured status (goal, decisions, files, tests, next step) + your `notes` + the previous session id and how to re-read it: `transcript_read {"sessionId":"<old>","query":"..."}` | yes |
| `harness-compact` | The harness's native `/compact` (`/compress` on hermes) runs on the source first. Same harness: then the model is switched in place. Harness or wallet changes: then a summary handoff taken from the now-compact source. | in place / yes |
| `none` | Nothing: only the model changes, in place (`set_config_option`). Same harness only. A harness that can't switch live (codex takes its model as a spawn argument) returns `in_place_not_supported`; there is no silent fallback. | no |
| `full-resume` | The whole transcript is replayed (`session_restart` with overrides). **Discouraged**: the prompt cache is rebuilt (expensive) and the new model inherits the old model's text. Refused on a self-call. | yes |

`harness-compact` can't run on yourself: `/compact` only executes after your
turn ends. To compact yourself use `session_command_self`.

## Axes and refusals

`model`, `harness`, `access.profileRef` are independent; an omitted one is
carried. Model policy (`modelPolicy`) and the auth profile's model allow-list
are enforced (in-place modes pre-check them; new sessions go through the same
guards as `agent_start`). A refusal is explicit and nothing is switched:

`nothing_to_change`, `model_refused` (profile / policy / wallet / adapter
incompatibility), `harness_change_needs_new_session`, `in_place_not_supported`,
`compact_from_self`, `compact_failed`, `full_resume_from_self`, `spawn_refused`.

On a self-call there is no one to ask for a summary (you are mid-turn), so
**`notes` is the summary**: write goal, what is done, the next step.

The CLI/HTTP `agentproto sessions handoff <id> --to <harness>` is the operator
twin of `handoff-summary` (it leaves the source running).
