---
name: browser
description: >-
  Drive the user's REAL authenticated browser (their logins/cookies) via the
  local-browser chain — guilde → tunnel → daemon → chrome-devtools-mcp → cloned
  Chrome. The foundation skill for any "do X in a browser as me" task: navigate,
  capture (element screenshots + selective content/ld+json/readability), inspect
  network, manage tabs/cookies/consent, and — for data — talk to a site's OWN
  internal API instead of its fragile DOM. Site-specific recipes are separate
  skills (linkedin, x-twitter, youtube, instagram, tiktok, leboncoin,
  news-media) that build on this one.
metadata:
  tags:
    browser, local-browser, chrome-devtools, agentproto, automation, recon,
    screenshots, extraction, cookies
---

# Browser — the authenticated-browser capability

**The browser is an authenticated transport to the user's real sessions.** Read
data from each site's own internal API (ground truth) and use the DOM only for
visuals + the few write buttons. Proven: on a hardened SPA the DOM yields ~0
useful data while an in-page API fetch returns the full structured truth.

## Where each concern lives (three homes, one boundary)

- **Capability = code.** The social capture/search recipes are implemented in
  `@agstudio/browser-social` (the `SOCIAL_PLATFORMS` adapters +
  `createLinkedInVoyager`). Drive the adapter; don't re-derive a recipe by hand.
- **Operator "how/when" = corpus playbook.** The durable judgement a _runtime_
  agent carries (recon SOP, persona = four signals, person-id scoring,
  when-to-escalate-stealth, rate-limit + write-gating discipline) is the
  `social-recon` corpus playbook overlay, injected into the operator's prompt
  (`projects/guilde/packages/builtins/src/knowledge/social-recon.ts`; read path
  in `apps/api/src/mastra/guilde-playbook-processors.ts`). A runtime operator
  cannot read these dev skills — the playbook is its home for that knowledge.
- **Dev-SOP = these skills.** What _you_ (building/debugging the stack) need:
  transport mechanics, the chrome-devtools-mcp tool surface, proven-live
  gotchas, the per-platform internal-API reference (a superset of what the
  adapters implement — includes gated write ops). This is the dev-facing mirror.

## Golden rules

1. **API-first for data** — find the site's internal API; the DOM is the slow,
   obfuscated, anti-scraping surface. News/content sites are the exception →
   readability/ld+json (content IS the HTML). See `reference/recon.md`.
2. **Fail fast** — ~8 s timeouts, not 60 s. After 5-6 s it's ~90 % a hard hang.
3. **Direct URL nav > clicking navigating-links** (clicks that navigate hang).
4. **Tab/focus discipline** — `list_pages` before acting; re-assert
   `select_page({pageId, bringToFront:true})` per op under multi-agent
   contention.
5. **Clear cookie/consent gates** — CMP banners + login/paywall cookies first.
6. **Gate every write** — acts as the user; explicit per-action confirmation.
7. **Capture cheaply** — snapshot/evaluate for data; screenshot only for pixels.
8. **Blocked? → stealth.** On a hard anti-bot block ("Sorry, you have been
   blocked" / Cloudflare / DataDome / 403-429-503), this Chrome chain won't
   recover — switch to the **camofox-stealth** MCP on agentproto:
   `mcp_imported_call alias="camofox-stealth" toolName="scrape"` (HTTP-first,
   auto-escalates) or `stealth_snapshot`. Needs the camofox server on :9377
   (launchd `com.agentik.camofox`). See
   `projects/browser/apps/stealth-mcp/README.md`.

## Reference (read what you need)

- `reference/transport.md` — chain, connection/health, Chrome lifecycle,
  tabs/focus, timeouts, the 29-tool surface + arg gotchas.
- `reference/capture.md` — **screenshots** (full / element by uid / CSS / CDP
  clip) + **selective content** (snapshot / evaluate querySelector / ld+json /
  readability).
- `reference/cookies.md` — cookie inspection, **CMP consent**, paywall/session
  injection, the login gate.
- `reference/recon.md` — the method to find + drive a site's **internal API**
  (the SOP-of-SOP); per-app auth tricks.
- `reference/writes.md` — gated write discipline + rate-limiting.

## Site skills (instances built on this)

`linkedin` (proven, deepest) · `x-twitter` · `youtube` · `instagram` · `tiktok`
· `leboncoin` · `news-media`. Each carries its internal API, auth/cookies,
recipes, and capture method. Invoke the site skill for site work; it leans on
this skill for the mechanics.

## Quickstart

```
health: api 3040 · tunnel 3600 (/internal/forward→401) · daemon 18790 (/health→200)
   (else: agentproto serve --connect ws://localhost:3600/connect)
list_pages → select your tab → navigate/snapshot/evaluate → (data) in-page API fetch
```

## Helper library (one-call primitives)

`projects/guilde/apps/api/scripts/lib/browser.ts` → `createBrowser()`:
`tabs() · focus(host|id) · nav · snapshot · evaluate · extract(selector) · screenshotElement(uid) · fetchJson(url, csrfCookie) · apiReqs(re) · click/fill/press · newTab/closeTab`.
LinkedIn layer: `createLinkedInVoyager(createBrowser())` —
`createLinkedInVoyager` from `@agstudio/browser-social` drives this
`createBrowser()` port
(`liFetch · feed · profileActivity · profile · reactors(activityUrn) · searchContent(query) · messageDraft`).
`searchContent` = keyword post search: walks the RSC result cards (hashed DOM,
no client-side URNs) then resolves real activity permalinks per /in/ author via
Voyager activity; /company/ authors keep the profile URL. STEALTH-preferred
equivalent: `social-scrape.mts content linkedin "<query>"` (camofox, distinct
session + WhatsApp re-auth alert). See the **`linkedin`** skill. Ad-hoc CLI:
`tsx scripts/browse.ts <tabs|focus|nav|snapshot|extract|fetch|shot|reqs>`.
Prefer these over ad-hoc scripts. (Validated: tabs + extract live.)
