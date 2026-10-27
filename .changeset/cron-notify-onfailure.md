---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/skill-pack-agentproto": patch
---

Let a cron job declare `notify: "onFailure"` so a successful `kind: "command"` run reaches followers as an `fyi` inbox entry instead of waking them. A failing command still crashes and wakes. Exposed by `cron_create`, `cron_update`, `cron_list`, `POST /cron`, `PATCH /cron/:id`, and `agentproto cron add --notify`.
