---
name: news-media
description: >-
  Read paywalled news/media (lemonde.fr, nytimes, ft, mediapart) via the browser
  skill: handle the CMP consent wall, use the subscriber/paywall cookie, extract
  via ld+json / readability. Use for 'read/extract this article' on EU/paywalled
  news.
metadata:
  tags: browser, news-media, internal-api, recon, social-graph
---

# News / media (lemonde.fr, etc.) — recon plan

**Different pattern from social.** News content lives in the **HTML article
body** (not a social GraphQL API), so here **readability extraction wins** —
API-first does NOT apply. The two real gates are **(1) the CMP consent wall**
and **(2) the paywall/subscriber session**. Worked example: lemonde.fr (probed
live).

## The two gates

### 1. CMP consent wall (EU sites — the FIRST blocker) ✅ handled live

> Validated on lemonde.fr: the accept button is **`"Accepter et continuer"`** —
> snapshot → click it → `hasConsent` flips **false → true** (euconsent/didomi
> cookie set), wall cleared for the session. (Other labels below for other
> CMPs.)

Le Monde shows a full GDPR consent wall before content: _"L'accès gratuit au
site … subordonné à votre consentement"_ with `button "Gestion des cookies"`,
`"À quoi servent les cookies ?"`, and accept/subscribe choices. Until handled,
content + scraping are blocked.

- **Handle it:** `take_snapshot` → find the accept button (labels vary:
  `"Accepter et fermer"` / `"Tout accepter"` / `"J'accepte"` /
  `"Continuer sans accepter"` / sometimes only `"S'abonner"` as the
  consent-choice) → `click` it.
- Persists a consent cookie (`euconsent-v2` / `didomi_token` / `sp_*`) → no
  re-prompt that session. (Observed pre-consent cookies: `atauthority`,
  `pa_privacy`, `_pctx`, `lmd_pa`; `hasConsent:false` until accepted.)
- CMP vendors are reused across sites: **Didomi** (lemonde, many FR),
  **Sourcepoint** (`sp_`), **OneTrust** (`#onetrust-accept-btn-handler`),
  **Quantcast/TCF**. Recognize the vendor → known accept selector.

### 2. Paywall / subscriber session

Full articles need a logged-in **subscriber** cookie. Not logged in → only free/
metered articles + "Article réservé aux abonnés". With the user's subscriber
session in the cloned profile, full text renders. (Le Monde here: NOT subscribed
→ exclusive content gated.) See the cookies section in the `browser` skill for
injecting a synced subscriber session.

## Extraction (readability — content IS the HTML)

After CMP + (paywall ok), the article is in the DOM:

- `evaluate_script` →
  `{ title: document.querySelector('h1')?.innerText, author: meta[name=author] or .author, date: time[datetime], body: article/.article__content innerText }`.
- ✅ Or pull `<script type="application/ld+json">` (NewsArticle) — validated
  live on Le Monde: `headline`, `author`, `datePublished`, `articleSection` come
  through cleanly; `articleBody` is empty (`bodyChars:0`) when paywalled/not a
  subscriber (metadata + the free intro are still readable via the selector).
  Stable, structured, paywall-aware — prefer it for news metadata.
- The guilde **scrapePage** tool (Defuddle/readability via the tiered router)
  already does clean article→markdown — prefer it for one-off reads.

## Recipes

- **Read an article**: navigate → handle CMP → extract (ld+json or readability).
- **Section feed**: navigate a section (e.g. `/international/`) → list article
  links (DOM) → batch-read.
- **Search**: `/recherche/?search_keywords=<q>` → result links → read.
- **Rare content API**: some outlets expose `/api/` JSON (capture via
  list_network_requests) — but most are HTML-first; don't force API-first here.

## Gotchas

- **CMP is mandatory** — skip it and you get the wall, not the article.
- Paywall: respect it — subscriber session for full text; otherwise free/metered
  only.
- ld+json is the most reliable structured source when present.
- Generalizes to any news/blog/paywalled-content site (nytimes, ft, mediapart…):
  same CMP → subscriber-cookie → readability flow.
