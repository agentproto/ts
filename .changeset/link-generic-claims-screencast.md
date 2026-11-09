---
"@agentproto/runtime": patch
---

`app_link_mint` takes an optional `sessionId` and a generic `claims` map (names `^[A-Za-z][A-Za-z0-9_]{0,31}$`, values 1 to 200 characters, 8 at most, daemon-owned names refused), so a link can be about an approval or a dossier and not only a session. `POST /apps/:appId/link-auth` answers with the link's non-reserved `claims` and no longer requires a `sessionId` claim. A link-session token can now also read the screencast routes (`/sessions/:id/screencast`, `.jpg`, `.mjpg`, `?token=` accepted) of its own session.
