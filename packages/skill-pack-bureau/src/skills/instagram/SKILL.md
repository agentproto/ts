---
name: instagram
description: >-
  Drive the user's authenticated Instagram via the browser skill: profiles,
  media likers/comments, followers/following, search via the web private API;
  gated like/comment/follow/DM. Use for Instagram research/outreach as the user.
metadata:
  tags: browser, instagram, internal-api, recon, social-graph
---

# Instagram — recon plan (web private API)

> ✅ **Instagram adapter** — `SOCIAL_PLATFORMS.instagram` in
> `@agstudio/browser-social` (`instagram.adapter.ts`): profile · authored ·
> connection (followers/following) · engagement-received (commenters — the only
> IG edge; likers 403), as a `SocialSourcePort`. In-page `igFetch`
> (x-ig-app-id + x-csrftoken) + re-focus drift defense. **Graph ingest:**
> `scripts/profile.ts instagram <username> --graph-only` → registry capture →
> `landFootprint` graph sink (platform `"instagram"`): profile→SocialPerson,
> posts→AUTHORED, commenters→COMMENTED, followers/following→FOLLOWS. Same domain
> as LinkedIn → cross-platform queries just work. Likers stay 403.

> ✅ **Validated live (logged in, read-only):** headers
> `x-ig-app-id:936619743392459`
>
> - `x-csrftoken`(csrftoken) + `x-requested-with:XMLHttpRequest`.
>   `web_profile_info?username=`→200 (pk, full_name, follower/post counts).
>   `feed/user/<pk>/?count=N`→200 (media: code, pk, like_count, comment_count,
>   caption). `media/<pk>/comments/`→200 (commenters: @username + user pk + text
>   = engagement edge). ⚠️ `media/<pk>/likers/`→**403** (IG hides likers). IG
>   graph = followers/following + **commenters**, not likers. web_profile_info
>   media edges are empty → use `feed/user/<pk>/`.

**Internal API:** web private REST `https://www.instagram.com/api/v1/...` +
GraphQL `https://www.instagram.com/graphql/query` (and `/api/graphql`) using
`doc_id`. The web UI calls these directly.

## Auth (from the page)

- cookies (`sessionid`, `csrftoken`, `ds_user_id`) ride same-origin.
- headers required:
  - `x-ig-app-id: 936619743392459` (the web app id — stable; also in the page's
    shared-data / a request header, capture to confirm),
  - `x-csrftoken: <csrftoken cookie>`,
  - `x-requested-with: XMLHttpRequest`,
  - `x-asbd-id` (a small constant in requests — capture),
  - `x-ig-www-claim` (echoed from a prior response header `x-ig-set-www-claim`).

In-page fetch:

```js
async path => {
  const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1]
  const r = await fetch(path, {
    headers: {
      "x-ig-app-id": "936619743392459",
      "x-csrftoken": csrf,
      "x-requested-with": "XMLHttpRequest",
    },
  })
  return await r.json()
}
```

## Endpoints to test

| Purpose                   | endpoint                                                                      |
| ------------------------- | ----------------------------------------------------------------------------- |
| Feed / timeline           | `POST /api/v1/feed/timeline/`                                                 |
| Profile by username       | `GET /api/v1/users/web_profile_info/?username=<u>` → user pk + recent media   |
| User media                | `GET /api/v1/feed/user/<pk>/`                                                 |
| **Followers / following** | `GET /api/v1/friendships/<pk>/followers/` · `/following/` (`max_id` paginate) |
| **Who liked a post**      | `GET /api/v1/media/<mediaId>/likers/`                                         |
| **Comments**              | `GET /api/v1/media/<mediaId>/comments/`                                       |
| Search users              | `GET /api/v1/web/search/topsearch/?query=<q>` (or GraphQL)                    |
| WRITE: like               | `POST /api/v1/web/likes/<mediaId>/like/`                                      |
| WRITE: comment            | `POST /api/v1/web/comments/<mediaId>/add/`                                    |
| WRITE: follow             | `POST /api/v1/friendships/create/<pk>/`                                       |
| WRITE: DM                 | `POST /api/v1/direct_v2/threads/broadcast/text/`                              |

## Entity model

`User{pk, username, full_name, follower_count, is_private}` ·
`Media{id, code(shortcode), caption, like_count, comment_count, owner:User}` ·
`Comment{user, text}`.

## Capture method

Open instagram.com → `list_network_requests` for `/api/v1/` + `/graphql/` → read
endpoint + `x-ig-app-id` / `x-asbd-id` / `x-ig-www-claim` from a request header,
and `doc_id` for GraphQL ops.

## Actions to test (read-first; writes gated)

1. `web_profile_info?username=` → pk + recent media + counts.
2. `media/<id>/likers/` + `/comments/` → **who engaged** (→ persona/graph).
3. `friendships/<pk>/followers/` → network sample.
4. `topsearch?query=` → discover users → score → dossier.
5. (gated) like / comment / follow / DM — explicit confirm, **heavily
   rate-limited**.

## Gotchas

- `doc_id` (GraphQL) + endpoints drift; private accounts gate most reads.
- IG is **aggressive on automation** — space requests, low volume, expect
  challenges/checkpoints on bursts. Writes especially risky → minimal + gated.
- Some POSTs need a `signed_body` / additional params — capture the real
  request.
