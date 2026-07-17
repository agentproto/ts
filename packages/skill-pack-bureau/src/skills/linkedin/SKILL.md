---
name: linkedin
description: >-
  Drive the user's real authenticated LinkedIn — via camofox stealth (preferred,
  distinct session + WhatsApp re-auth alert) or the chrome-devtools chain
  (fallback). API-first: read feed/profiles/activity, who-reacted/commented,
  connections, people + content search (who posted about a topic, with resolved
  permalinks), and build persona dossiers + engagement graphs — all FROM SOURCE
  via LinkedIn's Voyager API (page-context fetch), not fragile DOM. Plus gated
  write actions: message + attachment (API-first), inbox read, and the
  relationship graph (invite ±note / withdraw, via the trusted-input UI ladder
  since connect/withdraw are SDUI). Use for any "do X on LinkedIn as me" / "find
  + research + reach out to people" task.
metadata:
  tags:
    linkedin, voyager, persona, social-graph, camofox, stealth, local-browser,
    chrome-devtools, content-search, agentproto, sop
---

# LinkedIn skill

**The browser is just an authenticated transport. The data lives in LinkedIn's
own internal API (Voyager). Read from source, not the DOM.** (DOM selectors
returned 0 reliably; a Voyager fetch returned 217 KB of structured truth.)

## Golden rules

1. **API-first** — every read is a Voyager fetch; DOM only for the few write
   buttons.
2. **Fail fast** — ~8 s timeouts, not 60 s. After 5-6 s it's ~90 % a hard hang.
3. **Prefer direct navigation to URLs** over clicking links/buttons that
   navigate (they hang).
4. **Tab/focus discipline** — `list_pages` before acting; `new_page` to isolate.
5. **queryIds + selectors DRIFT** — capture live each session; never hardcode.
6. **Gate every write** — acts as the user; explicit per-send confirmation.

## Read this in order

- `reference/transport.md` — chain, lifecycle, tab/focus, timeouts, tool
  gotchas.
- `reference/voyager.md` — **the data layer**: the fetch primitive + query
  library + capture method + entity model.
- `reference/recipes.md` — read recipes (feed, profile, activity,
  who-reacted/commented, connections, search + the identification scorer).
- `reference/write-actions.md` — message + attachment (✅ proven, API-first) +
  the relationship graph (invite ±note / **withdraw**, ✅ via `social_network` /
  the trusted-input ladder; connect+withdraw are SDUI, not a fetch), gated,
  safety rails.
- `reference/playbooks.md` — **the 100x layer**: persona dossiers, the
  engagement/relationship graph, discover→dossier→outreach.

## Quickstart (once the browser is free)

```
1. health: api 3040 · tunnel 3600 · daemon 18790  (else: agentproto serve --connect ws://localhost:3600/connect)
2. navigate any linkedin.com page → liFetch(voyagerFeedDashMainFeed, …) → structured feed
3. for a person: search + score → persona.build → (gated) reach out
```

Harnesses: `projects/guilde/apps/api/scripts/linkedin-explore.ts`
(feed/profile/search/req) and `linkedin-message.ts` (`--send` gated).
Connect-with-note flow in `write-actions.md`.

## Two transports — prefer camofox (stealth)

Same Voyager-API-first philosophy, two ways to be the authenticated page:

- **Camofox (PREFERRED — stealth Firefox, distinct session).** A dedicated
  LinkedIn login native to camofox's fingerprint, separate from the daily-driver
  Chrome (so the site never bounces your real session). Auto-notifies on a login
  wall. Entry point:
  `projects/browser/packages/social/scripts/social-scrape.mts`
  (`@agstudio/browser-social`):
  ```
  tsx social-scrape.mts login linkedin --hold 300          # log in once, by hand, in the camofox window
  tsx social-scrape.mts linkedin <vanity> --slices authored,connections
  tsx social-scrape.mts search  linkedin "<query>"         # people → vanity
  tsx social-scrape.mts content linkedin "<query>" [--limit 20] [--date-range past-week]
  ```
- **Chrome chain (fallback).** `createLinkedInVoyager(createBrowser())` —
  `createLinkedInVoyager` from `@agstudio/browser-social`, driving the
  `createBrowser()` port (`scripts/lib/browser.ts`) over
  guilde→tunnel→daemon→chrome-devtools-mcp. Uses your daily Chrome session
  (revoke risk).

**Camofox auth gotcha (cost time once):** the launchd `:9377` camofox service
(`~/Library/LaunchAgents/com.agentik.camofox.plist`) MUST set
`EnvironmentVariables/CAMOFOX_PROFILE_DIR = ~/.agentproto/camofox-profiles`,
else `server.js` never restores the persisted session
(`camofox-profiles/linkedin.json`) and every tab bounces to `/login` despite a
valid saved login. After fixing: `launchctl unload/load` the plist;
`userId="linkedin"` restores authed (verify `voyager/api/me` → 200).

**Auth-notify:** on a login/anti-bot wall, `makeChallengeHandler`
(`social/scripts/lib/challenge.mts`) WhatsApps you ("résous dans la fenêtre
camofox, je reprends") via `resolveAlertChannel` (Simone number,
`WHATSAPP_ADMIN_PHONES`), then polls until cleared. Fires only on `isBlocked()`.

## Content search (who posted about a topic)

LinkedIn content search is 100% RSC — hashed DOM, **no client-side URNs**, and
all Voyager `/search/*` routes are dead (404/400/500). So `content linkedin`
(and the Chrome `searchContent`) walk the rendered result cards from author
anchors, then resolve real activity permalinks **post-hoc** per `/in/` author
via Voyager `profileUpdates` + exact normalized-text match (no false positives).
`/company/` authors keep the profile URL. People search (`search linkedin`)
reads the SSR cards passively instead.

## Status

✅ proven live: chain, Voyager fetch, feed/profile/activity endpoints,
search+scorer, message SEND + PDF/file attachment, inbox READ + media download,
relationship **withdraw** (productized `social_network` +
`social-cancel-request` workflow; read-back classifies `connectable` live). ✅
camofox transport — `userId="linkedin"` session restore (authed 200),
`content linkedin` search + post-hoc permalink resolution, WhatsApp
challenge-handler wired. ⏳ to capture: who-reacted / who-commented / per-person
reactions+comments queryIds — methods in `voyager.md`; DM-react (SDUI-walled).

> Foundation mechanics (transport, capture, cookies/consent, the
> find-the-internal-API method, gated writes): the **`browser`** skill. Other
> sites are their own skills: `x-twitter` · `youtube` · `instagram` · `tiktok` ·
> `leboncoin` · `news-media`. LinkedIn is the deepest worked instance.
