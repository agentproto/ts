# LinkedIn — read recipes

All built on the `liFetch` primitive (`voyager.md`). Pattern: navigate to a page
that primes the right cookies/context once, capture the live queryId, then loop
fetches. DOM only as a fallback.

## Feed loop ✅

1. `navigate_page /feed/` (expect a slow/never-idle load — proceed anyway).
2. `liFetch(voyagerFeedDashMainFeed, count:10,start:0,sortOrder:MEMBER_SETTING)`.
3. Per update →
   `{ author:Person (+ profileUrn), commentary, social{numLikes,numComments,reactionTypeCounts} }`.
4. Paginate with the feed `paginationToken`.

## Profile ✅

- `liFetch(voyagerIdentityDashProfiles, memberIdentity:<vanity-or-id>)` →
  identity (name, headline, location, current positions, urn). Prefer this over
  scraping `h1`/`.text-body-medium` (those returned empty live).

## A person's activity / voice / interests ⏳ (KEY for personas)

- Posts: `/in/<v>/recent-activity/posts/` →
  `voyagerFeedDashProfileUpdates(profileUrn)`.
- **Comments** (their _voice_ — what they say):
  `/in/<v>/recent-activity/comments/`.
- **Reactions** (their _interests_ — what they like):
  `/in/<v>/recent-activity/reactions/`.
- Capture each tab's queryId once via `list_network_requests`.

## Who reacted to a post ✅ (engagement edge = graph + persona seed, one snapshot)

**Fastest path (proven live):** open the post
(`/feed/update/urn:li:activity:<id>/`), `take_snapshot` — each reactor is in the
a11y tree as a single link whose label packs **name + reaction type + connection
degree + HEADLINE**, with the profile URL:

```
link "Simon Tannai a réagi avec Drôle, Relation de 1er niveau, Co-Founder & CTO @Givematic"
     url="https://www.linkedin.com/in/tannaisimon/"
```

Parse →
`Reaction{ actor:Person(name, headline, degree, profileUrl), reactionType }` — a
**persona stub per engaged person** in one call. No API needed for the top ~10.

- Reaction labels (fr→type): J'aime→LIKE · Bravo→PRAISE · Soutien→EMPATHY ·
  J'adore→APPRECIATION · Instructif→INTEREST · Drôle→ENTERTAINMENT.
- For the FULL list (beyond the visible ~10): click
  `link "Voir toutes les réactions"` → **modal opens, SAME label format** →
  accumulate reactors across the modal's virtualized scroll into a Set keyed by
  profileUrl. **No queryId needed** — drift-proof. The modal header gives
  ground-truth totals + per-type breakdown
  (`button "52 réactions de tout type"`, `button "42 réactions J'aime"`, …) even
  if you can't enumerate every person. ⚠️ `take_snapshot` only serializes
  **in-viewport** nodes of a virtualized list, and synthetic
  `scrollTop`/PageDown often won't advance LinkedIn's finite-scroll loader (esp.
  under multi-agent tab contention) — so enumeration can cap at the first
  viewport (~8–10). Pin a fresh, non-contended tab and use real wheel events for
  full enumeration; otherwise trust the header counts + the inline set.
- Helper: `createLinkedInVoyager(createBrowser()).reactors(urn)` (inline ~10) /
  `.fullReactors(urn)` (modal).

## Who commented what ✅ (inline a11y — no queryId, drift-proof)

Comments render **inline** on the post permalink — one `take_snapshot` captures
all loaded comments. Anchor on the per-comment options button; name + profile
link + headline + text sit adjacent:

```
link "Alexei Moltchan … 2e VP Product, Strategy…" url="https://www.linkedin.com/in/alexei-moltchan/"
button "Voir plus d'options pour le commentaire de Alexei Moltchan." expandable
generic → StaticText "Another AI slop, photos on the left and right image are different."
```

Parse → `Comment{ actor:Person(name, headline, profileUrl), text }` — a persona
stub per commenter. Scroll + click
`button "(Charger|Voir) plus de commentaires"` to load more. Helper:
`createLinkedInVoyager(createBrowser()).comments(urn, loadMore)`.

## Connections ✅ (REST API — NO queryId, drift-proof, paginates clean)

Use the **REST** endpoint, not the GraphQL resolver (whose hash drifts and whose
call gets truncated out of the network log):

```
/voyager/api/relationships/connectionsSummary           → { numConnections }   (ground truth)
/voyager/api/relationships/connections?start=0&count=40&sortType=RECENTLY_ADDED → { elements, paging }
```

Page `start += 40` until `elements` empty. Each element resolves to a person
(firstName/lastName + publicIdentifier + entityUrn) → `extractPeople()` →
`CONNECTED` edge from the ego node. Helper:
`createLinkedInVoyager(createBrowser()).connections({max})`

- `.connectionsCount()`. Proven: 3095 connections enumerable, 73 ingested in one
  run.

⚠️ **Selected-tab drift:** a sibling tab (e.g. localhost:3041 Guilde web) can
steal Chrome's selected page during `sleep`s, so an in-page fetch lands on the
wrong origin (→ empty/CORS). Fix = **re-focus the pinned LinkedIn pageId
immediately before each fetch, no sleep gap** (`ensureLi()` in
`@agstudio/browser-social`'s `linkedin-voyager.ts`). `/voyager/api/me` (200) is
a quick origin/auth check.

## Followers ⏳

- Profile → followers → `voyagerIdentityDashProfileFollowers(profileUrn)`
  (GraphQL, queryId via `captureQueryId`). REST equivalent TBD. → `FOLLOWS`
  edges.

## Search + identify ✅ (use the SCORER — see identification below)

1. `/search/results/people/?keywords=<q>` (loads more reliably than the feed).
2. Either fetch `voyagerSearchDashClusters` (structured) OR extract per result
   card.
3. **Score candidates** — never grab the first `/in/` link.

### Person-identification scorer (REQUIRED — avoids wrong-person)

Search returns several same-name people with **different vanity URLs**
(`mathilde-dugue` ≠ `mathilde-dugué-2a1459131`). Extract each candidate
`{name, headline, location, degree, url}` and score vs expected:

```
score = 0.4*nameFuzzy + 0.3*headlineKeyword + 0.2*locationMatch + 0.1*degreeMatch
```

Pick top; if margin small / ambiguous → **ask the user**. Prefer attributes from
the search Voyager JSON (stable) over DOM text (drifts).

## Warm-path / intro-mapping ✅ (bureau MCP, no queryId — prospecting at scale)

For outreach research (investors, press, any prospect list) the **lightest**
path is the bureau MCP tools on the owned `linkedin` camofox session — no
liFetch/queryId capture, just two tools. This built the Simone investor/press
warm-path maps (degree + mutuals across ~70 profiles, recurring-bridge
resolution).

1. **Name → profile:**
   `mcp__bureau__social_search {platform:"linkedin", kind:"people", session:"linkedin", query:"<Name> <Firm>", limit:2}`
   → `{url, handle, headline, location}`. Keep the query SIMPLE ("Name Firm");
   over-qualifying (`Name Firm partner`) → empty hits. Headlines sometimes leak
   a public email (e.g. `jean@2lr.com`).
2. **Degree + mutual connections (THE warm-path signal):**
   `mcp__bureau__scrape {url:<profile>, session:"linkedin", maxBytes:1700-2500}`
   → rendered text carries the **connection degree** (`· 1er / 2e / 3e`) and
   **mutuals** (`"Mariem, Yossef et 157 autres relations en commun"` = 159
   mutuals + 2 named bridges). **1er = direct DM · 2e = reachable via intro
   (warmth ∝ mutual count) · 3e = cold** (shows only "Suivi par N personnes que
   vous connaissez"). Public emails also surface in the Info block. Headline can
   flag "don't DM me" (e.g. Varza → use her site form, not LinkedIn).
3. **Resolve a recurring bridge → who can intro you:** when the same first-name
   recurs across many targets' mutuals (a super-connector), identify them by
   searching **your OWN 1st-degree** by that name:
   `scrape "/search/results/people/?keywords=<Name>&network=%5B%22F%22%5D&origin=FACETED_SEARCH" session:"linkedin"`
   → top hit (ranked by tie-strength) is usually the connector who can make
   MULTIPLE intros. One intro from them unlocks many targets (Simone: one
   "Harrison" → Harrison Chase = 5 funds).

Sort the prospect list by warmth (1er → 2e by mutual count → 3e) to get an
outreach order for free.

⚠️ Gotchas

- **Mutual named-list is URN-gated:** `connectionOf=["<publicHandle>"]` → "Aucun
  résultat". The facet needs the member URN (`ACoAAB…`), not the vanity — and
  `scrape` is text-only so you can't lift the URN. Read degree + mutual COUNT
  from the **profile-page scrape**; don't chase the full named list (or have the
  user click "N relations en commun").
- **CONTROL tab ≠ authed:** `browser_navigate`/`browser_evaluate` run on a
  SEPARATE context that bounces to `/uas/login`. Authed reads must carry
  `session:"linkedin"` (`scrape` / `social_search`), never the CONTROL tools.
- **Wrong vanity guess** (e.g. `/codorniou`) → "Cette page n'existe pas" → fall
  back to `social_search kind:people` for the real slug (it was `/julien`).
- `scrape` occasionally returns `NS_ERROR_ABORT` (transient) → just retry.
- Batch with small `maxBytes` (~1700) — only the top of the profile carries the
  degree + mutuals; the rest is post feed.

## Caching → workspace

Every fetched Person/Post → write JSON to the workspace (the MCP result
persister auto-syncs large/media; or `write_file`). Build a local LinkedIn KB;
query cache first, fetch only deltas. (`mcp-content/`, `mcp-media/` paths.)
