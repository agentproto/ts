---
"@agentproto/runtime": patch
---

fix(sentinel): `local-gh` now emits the terminal `pull_request.closed` event for a PR that was already merged/closed on its baseline poll (sentinel created after the close, or the PR closed before the first tick). Previously no open-to-closed transition was ever observed, so `until: subject_terminal` sentinels stayed `active` forever; existing stuck sentinels heal on their next poll.
