# Browser: recon, find and drive a site's internal API

**Modern apps already have a clean internal JSON API; the UI just calls it.
Drive THAT, from inside the authenticated page.** The DOM is the slow,
obfuscated, anti-scraping surface; the API is ground truth. The exception is
news and content sites, where the content IS the HTML: use readability instead
(the news recipe covers consent walls and paywalls).

## The 7 steps

1. **Open the right account.** Use the browser skill: `browser_list_instances`,
   `browser_list_accounts`, then open your own tab on the chosen account.
2. **Find the internal API.** Do the action in the UI and read
   `browser_list_requests`. Spot its API: a `/graphql` or `/api/` endpoint
   answering JSON. Note URL, method, params and auth headers.
3. **Replicate auth from the page (the key trick).** Same-origin requests
   authenticate through the profile's cookies plus one of these:
   - **CSRF echo**: a cookie value copied into a request header.
   - **Bearer constant** shipped in the site's JavaScript.
   - **App id or API key** in the page's config object.
   - **Signed token** computed by the page's own JavaScript: call the signer
     the page already loaded instead of reimplementing it.

   The fetch runs in the page, so cookies ride along; you add only the header
   or two the request needs.
4. **Fetch primitive.** `browser_evaluate` with an async expression that does
   `fetch(url, {headers})` and returns `await r.json()`. Wrap it as
   `appFetch(endpoint, vars)`.
5. **Typed query library.** One function per endpoint. Capture the live id or
   hash each session, because they drift. Parse JSON into a small entity model
   (Person, Post, Edge, or the site's own nouns).
6. **Playbooks (compose).** Dossier (aggregate an entity), graph
   (who-engages-whom), discover, dossier, act (search, score, research, gated
   outreach). The same shapes recur across sites.
7. **Writes: gated and minimal DOM.** See `writes.md`.

## Cross-app discipline

- **Cache to the workspace**: a local knowledge base per site; query the cache
  first, fetch deltas.
- **ids, hashes and selectors DRIFT**: capture live, never hardcode.
- **API first, DOM last** (news is the inverse). Screenshot only to verify or
  show.
- **Auth stays in the page**: never exfiltrate raw cookies or tokens.
- **`browser_get_request_body` is for recon**, not a bulk data source; an
  in-page fetch is the reusable read.

## Site recipes

A site recipe packages this pattern for one site: its endpoints, its auth
header and its write flows. Recipes ship separately from Bureau and are
installed per site; this reference stays site-neutral.
