---
"@agentproto/runtime": minor
---

ROLE.md accepts `contextFiles: tag=path, ...`: the daemon injects each file, fenced by `<tag>...</tag>`, into the spawn prompt right after the role disposition (`~` and `$VAR` expanded, an unreadable file announced as `<tag absent="path"/>`, 64 KiB cap). Ships `templates/roles/recherche/ROLE.md`, a role that puts the repo map in front of an agent asked to search globally.
