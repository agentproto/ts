---
name: leboncoin
description: >-
  Drive Leboncoin (FR marketplace) via the browser skill: search listings, ad
  detail, seller inventory, price/market scan, gated seller messaging —
  api.leboncoin.fr behind DataDome. Use for Leboncoin search/market tasks.
metadata:
  tags: browser, leboncoin, internal-api, recon, social-graph
---

# Leboncoin — recon plan (FR marketplace)

Not a social graph — a **marketplace**: the "nodes" are **Ads** and **Sellers**,
the edges are seller↔listings, category/location facets, and messaging. Same
recon method (find the API → auth from cookies → typed queries → playbooks).

**Internal API:** `https://api.leboncoin.fr/...` (the web app calls it
directly):

- **Search:** `POST https://api.leboncoin.fr/finder/search` — JSON body with
  `filters` (category, location {region/department/city}, keywords, price range,
  attributes), `limit`, `offset`, `sort_by`. Returns `ads[]` + facets.
- **Ad detail:** `GET https://api.leboncoin.fr/api/adview/v1/public/<listId>`
  (or the listing page hydration) — price, description, images, attributes,
  seller.
- **Seller:** the seller's other listings (search by `owner`/`user_id`),
  pro/private, ratings.
- **Messaging:** the conversation API (login required).

## Auth (from the page)

- `api_key` header — a **public web key** Leboncoin's JS sends on every call
  (capture from a request header).
- cookies ride same-origin, **including the `datadome` cookie** — Leboncoin is
  behind **DataDome anti-bot** (like a WAF). Because we run in the REAL browsing
  session, the valid `datadome` cookie is already present → page-context fetch
  passes. (This is the gate, analogous to TikTok's signing.)

In-page fetch:

```js
async body => {
  const r = await fetch("https://api.leboncoin.fr/finder/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      api_key: "<captured web api_key>",
    },
    body: JSON.stringify(body),
  })
  return await r.json()
}
```

## Entity model

`Ad{ list_id, subject, body, price, category, location{city,zipcode,lat,lng},    images[], attributes[], owner:Seller, index_date }`
· `Seller{ user_id, name, type: private|pro, siret?, no_of_ads, ratings? }` ·
`Category{ id, name }`.

## Recipes (read-first; writes gated)

- **Search listings**: `finder/search` with filters → ads (price, location,
  seller).
- **Ad detail**: `adview` → full ad + seller + images.
- **Seller's listings**: search filtered by the owner/user_id → their inventory
  (the "persona" of a seller = their listings + pricing + activity).
- **Market scan / price graph**: search a category+area → aggregate prices,
  freshness, sellers → a market view (the marketplace analog of the social
  graph).
- **Discovery → outreach**: find matching ads → (gated) message the seller.

## Capture method

Open leboncoin.fr, run a search/open an ad → `list_network_requests` for
`api.leboncoin.fr` → read the endpoint, the JSON body shape, and the `api_key`
header. Confirm the `datadome` cookie is set (else solve the challenge in the UI
first).

## Gotchas

- **DataDome**: bursts trigger a challenge/captcha. Keep volume low +
  human-spaced; if a request 403s with a DataDome body, solve it once in the UI
  (the cookie refreshes) then resume.
- Body filter schema is nuanced (category ids, location objects) — capture a
  real UI search's body and parameterize from it.
- Writes (message seller, post ad) need login + may add their own tokens —
  capture live.
