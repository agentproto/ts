# LinkedIn Voyager API — the data layer (API-first, not DOM)

The DOM is obfuscated + lazy (selectors return 0 reliably). **Read from
LinkedIn's own internal API (Voyager).** Validated live: a page-context fetch of
the feed returned **200, 217 KB, with `socialActions` (likes/reactions) +
`actor`**. This is the spine of everything.

## The fetch primitive ✅ (proven)

Run via `evaluate_script` from ANY linkedin.com page (same-origin → cookies +
csrf flow for free):

```js
;async () => {
  const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1] // CSRF == JSESSIONID
  const r = await fetch(URL, {
    headers: {
      "csrf-token": csrf,
      accept: "application/json",
      "x-restli-protocol-version": "2.0.0",
      "x-li-lang": "en_US",
    },
  })
  return { status: r.status, json: await r.json() }
}
```

Helper to standardize in harnesses: `liFetch(path)` → returns parsed JSON.

## Endpoint shape

```
GraphQL:  /voyager/api/graphql?includeWebMetadata=true&variables=(<RestLi tuple>)&queryId=<name>.<hash>
REST:     /voyager/api/<Resource>?<params>
```

`variables` use **RestLi tuple syntax** (NOT JSON):
`(count:20,start:0,profileUrn:urn:li:fsd_profile:XXXX)`; lists are `List(a,b)`;
nested URNs are URL-encoded.

## ⚠️ queryId hashes DRIFT every LinkedIn deploy. NEVER hardcode.

**Capture fresh each session:** open the page/UI that shows the data →
`list_network_requests({pageSize:150})` → grep `/voyager/api/graphql` → read the
live `queryId`. Then reuse that hash for the session. (Harness
`linkedin-explore.ts` dumps these to `/tmp/li-*.json`.)

## Query library

### ✅ Confirmed live this session

| Data                      | queryId / endpoint                                 | key variables                            |
| ------------------------- | -------------------------------------------------- | ---------------------------------------- |
| Main feed                 | `voyagerFeedDashMainFeed`                          | `count, start, sortOrder:MEMBER_SETTING` |
| A person's posts/activity | `voyagerFeedDashProfileUpdates`                    | `profileUrn, count, start`               |
| Profile (self/other)      | `voyagerIdentityDashProfiles`                      | `memberIdentity`                         |
| Messaging conversations   | `messengerConversations` (voyagerMessagingGraphQL) | `mailboxUrn`                             |
| Notifications             | `voyagerIdentityDashNotificationCards` (REST)      | `count, q=filterVanityName`              |

**✅ Feed parse confirmed (214 KB live):** each post yields
`urn:li:activity:<id>`, and social counts as `"numLikes":N`, `"numComments":N`,
and `"reactionTypeCounts":[{ "reactionType":"LIKE"|"PRAISE"|…, "count":N }]`.
The author lives under the update's `actor` (NOT a flat `"name"` — walk the
actor object; a naive `"name":{"text"}` regex misses it). `ProfileUpdates` → 200
even for a post-less profile (empty elements). Hashes seen this session (DRIFT,
verify): `MainFeed.923020905727c01516495a0ac90bb475`,
`ProfileUpdates.4af00b28d60ed0f1488018948daad822`,
`IdentityDashProfiles.b5c27c04968c409fc0ed3546575b9b7a`.

### ⏳ To capture (method noted — likely names from the Voyager namespace)

| Data                                         | likely queryId                                  | capture by                                           | key variables                                                |
| -------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| **Who REACTED to a post**                    | `voyagerSocialDashReactions`                    | open a post → click the reactions count → list reqs  | `threadUrn`/`*socialDetailUrn*`, reactionType?, count, start |
| **Comments on a post**                       | `voyagerSocialDashComments`                     | open a post's comments                               | `socialDetailUrn`, count, start, sortOrder                   |
| **A person's reactions** ("what they liked") | profile activity (reactions tab)                | nav `/in/<v>/recent-activity/reactions/` → list reqs | `profileUrn`, filter=reactions                               |
| **A person's comments** ("their voice")      | profile activity (comments tab)                 | nav `/in/<v>/recent-activity/comments/`              | `profileUrn`, filter=comments                                |
| **Connections**                              | `voyagerRelationshipsDashConnections`           | nav `/mynetwork/invite-connect/connections/`         | `count, start, sortType`                                     |
| **Followers / following of X**               | `voyagerIdentityDashProfileFollowers` / network | profile → followers                                  | `profileUrn`                                                 |
| **People search**                            | `voyagerSearchDashClusters`                     | `/search/results/people/?keywords=` → list reqs      | `query:(keywords:…,flagshipSearchIntent:…), start, count`    |
| **Company**                                  | `voyagerOrganizationDashCompanies`              | a company page                                       | `universalName`/`companyUrn`                                 |

> The **recent-activity tabs** are the key to per-person interests/voice:
> `/in/<vanity>/recent-activity/{all,posts,comments,reactions}/` — each backed
> by a Voyager activity query. This is how you get "what X liked / what X said."

## Entity model (parse targets)

```
Person   { urn(fsd_profile id), vanity, name, headline, location, degree, profileUrl }
Post     { activityUrn, author:Person, commentary(text), createdAt,
           social:{ numLikes, numComments, numShares, reactionTypeCounts:[{type,count}] } }
Reaction { actor:Person, reactionType }   // LIKE PRAISE EMPATHY INTEREST APPRECIATION ENTERTAINMENT
Comment  { actor:Person, text, createdAt, social }
Edge     { from:urn, to:urn, type: CONNECTED | FOLLOWS }
```

Where to find them in the JSON: posts under `*MainFeed*`/`*ProfileUpdates*`
collections; each update's `actor` (author), `commentary.text`, and
`*socialDetail*`/`socialActions` (`numLikes`, `numComments`,
`reactionTypeCounts`). URNs: `urn:li:fsd_profile:<id>` identifies a Person; the
post is `urn:li:activity:<id>` (its socialDetail URN drives reactions/comments).

## Pagination

Most collections: `start` + `count` (+ a `paginationToken`/`metadata` for the
feed). Loop `start += count` until empty. Cap + log (don't silently truncate).
