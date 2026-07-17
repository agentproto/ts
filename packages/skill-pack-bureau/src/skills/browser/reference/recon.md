# Browser — recon: find + drive a site's internal API (the SOP-of-SOP)

**Modern apps already have a clean internal JSON API; the UI just calls it.
Drive THAT, from inside the authenticated page.** The DOM is the slow,
obfuscated, anti-scraping surface; the API is ground truth. (Exception:
news/content sites → the content IS the HTML → readability, not API; see
`news-media`.)

## The 7 steps

1. **Authenticated transport** — `transport.md` (chain, tabs/focus, fail-fast).
2. **Find the internal API** — open the app, do the action;
   `list_network_requests`. Spot its API: `/graphql`, `/api/v1/`,
   `/youtubei/v1/`, `/i/api/graphql/`, XHR JSON. Note URL + method + params +
   auth headers.
3. **Replicate auth from page cookies (the key trick)** — same-origin requests
   authenticate via cookies + ONE of:
   - **CSRF echo** — a cookie copied into a header (LinkedIn
     `csrf-token`=JSESSIONID, IG `x-csrftoken`=csrftoken, X `x-csrf-token`=ct0),
   - **bearer constant** in the JS (X's public web bearer),
   - **app-id / API key** in page config (IG `x-ig-app-id`, YouTube
     `INNERTUBE_API_KEY` in `ytcfg`),
   - **signed token** computed by the app's JS (YouTube `SAPISIDHASH`, TikTok
     `X-Bogus`/`msToken`) — replicate in-page or call the app's own loaded
     signer. The fetch runs **in the page (same origin)** → cookies ride; you
     add only the header(s).
4. **Fetch primitive** —
   `evaluate_script(async () => { … fetch(url,{headers}) … return await r.json() })`.
   Wrap as `appFetch(endpoint, vars)`.
5. **Typed query library** — one fn per endpoint; **capture the live id/hash
   each session (they DRIFT)**. Parse JSON → a small entity model
   (Person/Post/Edge or the app's nouns).
6. **Playbooks (compose)** — dossier (aggregate an entity), graph
   (who-engages-whom), discover→dossier→act (search→score→research→gated
   outreach). Same shapes across apps.
7. **Writes: gated + minimal-DOM** — see `writes.md`.

## Cross-app discipline

- **Cache to workspace** — local KB per app; query cache first, fetch deltas.
- **ids/hashes/selectors DRIFT** — capture live; never hardcode.
- **API-first, DOM-last** (news is the inverse). Screenshot only to verify/show.
- **Auth stays in-page** — don't exfiltrate raw cookies/tokens.

## Proven instance

LinkedIn/Voyager (the `linkedin` skill): in-page fetch of `/voyager/api/graphql`
with `csrf-token`=JSESSIONID → 214 KB structured feed; engagement edge (who
reacted + type + headline + profile) straight from the post snapshot. The
template every other site skill follows.
