# bureau — browser automation pack

Bundles the skills for driving **real authenticated browsers** and **social platforms**
through the Bureau stack (Camofox stealth + daemon) or the local-browser chain.

## What's inside

| Skill | Triggers on | What it gives you |
|-------|-------------|-------------------|
| **bureau** | Working WITH the Bureau product itself — running the daemon, managing saved sessions/credentials, capturing footprints, probing adapter drift, hitting its /mcp surface | The packaged daemon + camofox stack: sessions, credentials, social capture, workflows, Guilde connection. Distinct from `browser` (user's own Chrome). |
| **browser** | "do X in a browser as me", navigate, capture, inspect network, manage tabs/cookies/consent, talk to a site's internal API | Drive the user's REAL authenticated browser via the local-browser chain: guilde → tunnel → daemon → chrome-devtools-mcp → cloned Chrome. DOM + network + API-first data extraction. |
| **linkedin** | "do X on LinkedIn as me", find + research + reach out to people | API-first via Voyager: read feed/profiles/activity, who-reacted/commented, connections, people + content search, gated write (message + attachment, inbox read, invite/withdraw). |
| **x-twitter** | "do X on Twitter/X as me", read timelines/profiles, who-liked/retweeted, search, gated posts/likes/DMs | X's internal GraphQL API: read timelines, profiles, Favoriters/Retweeters, search, gated write actions. |
| **youtube** | "do X on YouTube as me", channels, videos, comments + commenters, search | InnerTube API: channels, videos, comments + commenters, search; gated like/comment/subscribe. |
| **instagram** | "do X on Instagram as me", profiles, media likers/comments, followers/following, search | Web private API: profiles, media likers/comments, followers/following, search; gated like/comment/follow/DM. |
| **tiktok** | "do X on TikTok as me", feed/user/comments | /api endpoints (signing-gated): feed, user, comments; read via page responses. |
| **news-media** | "read this article" on EU/paywalled news (lemonde, nytimes, ft, mediapart) | Browser skill + CMP consent wall + subscriber cookie + ld+json/readability extraction. |
| **leboncoin** | Search listings, ad detail, seller inventory, price/market scan, gated seller messaging | api.leboncoin.fr behind DataDome: search, ad detail, seller inventory, price scan, gated messaging. |

## How it works

All skills build on the `browser` foundation skill. `bureau` is the product-specific
skill for the packaged daemon; `browser` is the generic local-browser chain.

Platform-specific skills (linkedin, x-twitter, youtube, instagram, tiktok) each
have their own internal API recipes and write-action gating.

## Changelog

- **0.1.0** — initial pack: bureau, browser, linkedin, x-twitter, youtube,
  instagram, tiktok, news-media, leboncoin. 9 skills total.
