---
name: x-twitter
description: >-
  Drive the user's authenticated X/Twitter via the browser skill: read
  timelines/profiles, who-liked/retweeted (Favoriters/Retweeters), search, and
  gated posts/likes/DMs through X's internal GraphQL API. Use for any 'do X on
  Twitter/X as me' or build-the-X-graph task.
metadata:
  tags: browser, x-twitter, internal-api, recon, social-graph
---

# X / Twitter — recon plan

> ✅ **SHIPPED on the Camofox stealth session** (X flags CDP-Chromium → use
> Camofox, not the local-browser chain). Helpers:
>
> - `scripts/lib/camofox.ts` (`createCamofox`) — Camofox-service REST client
>   (tabs/navigate/click/type/evaluate + `fetchInPage`). baseUrl via
>   `CAMOFOX_URL` (⚠️ use `127.0.0.1`, not `localhost` — node/undici picks IPv6
>   ::1 and fails).
> - **X adapter** — `SOCIAL_PLATFORMS.x` in `@agstudio/browser-social`
>   (`sites/x/adapter.ts`): profile · authored · engagement-given/received ·
>   connections, as a `SocialSourcePort`. queryIds read **live from X's JS
>   bundle** (drift-proof); `features` flags **self-heal** on 400s. The capture
>   recipe lives in the registry, not a script-local helper.
> - **Graph ingest:**
>   `scripts/profile.ts x <handle> --graph-only [--depth quick]` → registry
>   capture → `landFootprint` graph sink (platform `"x"`): profile→SocialPerson,
>   posts→AUTHORED, connections→FOLLOWS. Validated live: @romanbuildsaas → 73
>   records · 74 graph ops.
> - **Login** done via Camofox (cookie-banner dismissed via `/evaluate` JS, then
>   username→password→Continue). ⚠️ Followers list often **404s** for
>   large/protected accounts; Favoriters/Retweeters load lazily →
>   `captureMore()` after opening the likes/retweets modal. Gecko: no CDP, but
>   `/evaluate` works (used for the API calls).
>
> Legacy note: the local-browser cloned profile is NOT logged into X and X flags
> CDP anyway — the Camofox path above supersedes it.

**Internal API:** GraphQL at
`https://x.com/i/api/graphql/<queryId>/<OperationName>` (+ some REST
`https://x.com/i/api/1.1/` and `/2/`). Same shape as Voyager: the web app calls
its own GraphQL; we drive that in-page.

## Auth (capture from any /i/api/graphql request header)

- `authorization: Bearer <web-app bearer>` — a **constant** embedded in X's JS
  (same for all web users; long `AAAA…`). Capture once.
- `x-csrf-token: <ct0 cookie>` — per-session; read from `document.cookie` (ct0).
- cookies (`auth_token`, `ct0`) ride automatically (same-origin).
- also: `x-twitter-active-user: yes`, `x-twitter-auth-type: OAuth2Session`,
  `x-twitter-client-language: en`.

In-page fetch:

```js
;async () => {
  const ct0 = (document.cookie.match(/ct0=([^;]+)/) || [])[1]
  const r = await fetch(URL, {
    headers: {
      authorization: BEARER,
      "x-csrf-token": ct0,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "content-type": "application/json",
    },
  })
  return await r.json()
}
```

## Operations to capture + test (queryId + `features`/`variables` DRIFT)

| Purpose               | Operation                                                |
| --------------------- | -------------------------------------------------------- |
| Feed                  | `HomeTimeline` / `HomeLatestTimeline`                    |
| Profile → rest_id     | `UserByScreenName(screen_name)`                          |
| A user's tweets       | `UserTweets` / `UserTweetsAndReplies(userId)`            |
| Tweet + replies       | `TweetDetail(focalTweetId)`                              |
| **Who liked**         | `Favoriters(tweetId)`                                    |
| **Who retweeted**     | `Retweeters(tweetId)`                                    |
| Following / Followers | `Following` / `Followers(userId)`                        |
| Search                | `SearchTimeline(rawQuery, product)`                      |
| WRITE: tweet          | `CreateTweet`                                            |
| WRITE: like           | `FavoriteTweet`                                          |
| WRITE: retweet        | `CreateRetweet`                                          |
| WRITE: DM             | REST `/1.1/dm/new2.json` or `/i/api/1.1/dm/conversation` |

## Entity model

`User{rest_id, screen_name, name, followers_count, …}` ·
`Tweet{id, full_text, author:User, favorite_count, retweet_count, reply_count, bookmark_count}`.
Responses are `instructions[].entries[]` timeline trees → walk to
`tweet_results.result`.

## Capture method

Open x.com → `list_network_requests` → find `/i/api/graphql/` → read queryId +
OperationName + grab `authorization` (bearer) + the `variables`/`features`
objects from the request. Reuse for the session.

## Actions to test (read-first; writes gated)

1. UserByScreenName → rest_id for a target.
2. UserTweets → their recent tweets + counts.
3. Favoriters/Retweeters on one tweet → **who engaged** (→ persona/graph).
4. SearchTimeline → discover accounts → score → dossier.
5. (gated) FavoriteTweet / CreateTweet / DM — explicit confirm, rate-limited.

## Gotchas

- GraphQL needs a `features` object (toggles) that DRIFTS — capture live or the
  request 400s.
- queryIds rotate per deploy. ct0 must match the cookie exactly.
- `x.com` vs `twitter.com` origin — use whichever the tab is on (cookies are
  per-domain).
