---
name: youtube
description: >-
  Drive the user's authenticated YouTube via the browser skill: channels,
  videos, comments + commenters, search via the InnerTube API; gated
  like/comment/subscribe. Use for YouTube research/automation as the user.
metadata:
  tags: browser, youtube, internal-api, recon, social-graph
---

# YouTube — recon plan (InnerTube API)

**Internal API:** InnerTube —
`POST https://www.youtube.com/youtubei/v1/<endpoint>?key=<INNERTUBE_API_KEY>&prettyPrint=false`,
body `{ context: <INNERTUBE_CONTEXT>, ...params }`. The web app uses this for
everything.

## Config + auth (from the page)

- `INNERTUBE_API_KEY` + `INNERTUBE_CONTEXT` live in `ytcfg`. Read in-page:
  ```js
  ;() => ({
    key: ytcfg.get("INNERTUBE_API_KEY"),
    ctx: ytcfg.get("INNERTUBE_CONTEXT"),
  })
  ```
- Public reads: often work with just key + context (no auth).
- Personalized / write (subscriptions, comments, like): need **SAPISIDHASH**
  auth:
  - `Authorization: SAPISIDHASH <ts>_<SHA1(ts + " " + SAPISID + " " + origin)>`
    where SAPISID = the `SAPISID` (or `__Secure-3PAPISID`) cookie, origin =
    `https://www.youtube.com`, ts = unix seconds. Compute SHA-1 in-page
    (SubtleCrypto). Also send `X-Goog-AuthUser: 0`, `Origin`, cookies (auto).

In-page fetch:

```js
;async (endpoint, body) => {
  const key = ytcfg.get("INNERTUBE_API_KEY")
  const r = await fetch(
    `/youtubei/v1/${endpoint}?key=${key}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json" /* + SAPISIDHASH for writes */,
      },
      body: JSON.stringify({
        context: ytcfg.get("INNERTUBE_CONTEXT"),
        ...body,
      }),
    }
  )
  return await r.json()
}
```

## Endpoints to test

| Purpose                             | endpoint                                          | params                             |
| ----------------------------------- | ------------------------------------------------- | ---------------------------------- |
| Channel / home / playlist           | `browse`                                          | `browseId` (channel UC…), `params` |
| Watch page → video + comments token | `next`                                            | `videoId`                          |
| **Comments** (+ who/likes)          | `next` (continuation token from the watch `next`) | `continuation`                     |
| Search                              | `search`                                          | `query`, `params`                  |
| Video metadata                      | `player`                                          | `videoId`                          |
| WRITE: comment                      | `comment/create_comment` / `create_comment_reply` | `createCommentParams`              |
| WRITE: like/dislike                 | `like/like` / `like/dislike` / `like/removelike`  | `target.videoId`                   |
| WRITE: subscribe                    | `subscription/subscribe` / `unsubscribe`          | `channelIds`                       |

## Entity model

`Channel{browseId, title, subscriberCount}` ·
`Video{videoId, title, author, viewCount, likeCount}` ·
`Comment{author, text, likeCount, replyCount}`. Responses are deeply nested
**renderer trees** (`*Renderer`) — walk to the renderer that holds the field
(e.g. `commentRenderer`, `videoRenderer`).

## Capture method

Open youtube.com → read ytcfg (above) → `list_network_requests` for
`/youtubei/v1/` → see the endpoint + the body params + continuation tokens.

## Actions to test (read-first; writes gated)

1. read ytcfg key+context.
2. `search` a topic → videos.
3. `next(videoId)` → video + first comments → **who commented + likes** (→
   graph).
4. `browse(channelId)` → a creator's videos/about.
5. (gated, needs SAPISIDHASH) comment / like / subscribe — explicit confirm.

## Gotchas

- SAPISIDHASH required for any authenticated/write call — compute in-page from
  the SAPISID cookie (SubtleCrypto SHA-1). Read-only public data may skip it.
- Renderer trees are verbose; extract by walking for the specific `*Renderer`.
- Comments come via a continuation token from the `next` response, not a flat
  list.
