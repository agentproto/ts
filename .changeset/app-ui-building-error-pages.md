---
"@agentproto/runtime": patch
---

`ui://app_ui_<id>/view` and `GET /apps/:appId/ui` no longer block on a full `ui.build` run or serve raw `{"error":...}` JSON as page text. A build in flight now serves a self-refreshing "building" placeholder; a missing bundle, missing `ui.build`, a failed build, or a removed app dir now serves a readable HTML error page. `app_list`/`app_status` also report `dirMissing: true` for an installed app whose `dir` no longer exists.
