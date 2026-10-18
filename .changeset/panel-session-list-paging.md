---
"@agentproto/apps": patch
---

fix(apps): follow the `session_list` cursor in every first-party panel (sessions-panel, agents-overview, bureau-sessions, session-story, ops-panel, session-viewer) so the new default 50-row bound no longer silently truncates their lists
