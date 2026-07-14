# Browser — capture: screenshots + selective content

**Rule of thumb: screenshot only when you need PIXELS (visual check / VLM look).
For data, use text capture — it's cheaper + parseable.**

## Screenshots (pixels)

| Scope                       | How                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Viewport / full page        | `take_screenshot({format})` · `{fullPage:true}`                                                                                                                                                                                                  |
| **One element (by uid)** ✅ | `take_snapshot` → element `uid` → `take_screenshot({uid})` — crops to that element's box, auto-scrolls into view. `fullPage` incompatible with `uid`. Target the **container** uid (article/content div) for the whole block, not just the `h1`. |
| One element (by CSS)        | our headless driver: `browserScreenshot({selector})` · `browserCapture({mode:"elements", selectors:[…]})` (batch)                                                                                                                                |
| Arbitrary box               | CDP: `evaluate` → `el.getBoundingClientRect()` → `driver.send(Page.captureScreenshot, {clip:{x,y,width,height,scale:1}})`                                                                                                                        |

- Media auto-saves to the workspace (the MCP result persister) → re-read with
  `imageReader`. Don't dump base64 to context.

## Selective content (text / structured) — easiest first

| Want                                    | Tool                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| "what's on this page" (clean text)      | **`take_snapshot`** — the a11y tree is structured, selective text (no HTML noise). `{filePath}` to save big ones.                      |
| "the text of THIS element"              | **`evaluate_script(() => document.querySelector(sel).innerText)`** — one line, just that region ✅                                     |
| typed fields (author/date/price/counts) | **`ld+json`** (news: `script[type="application/ld+json"]` → NewsArticle) ✅ · or the site's internal **API JSON** (social/marketplace) |
| clean article → markdown                | the guilde **`scrapePage`** tool (readability via the tiered router)                                                                   |

**JS bridge (your "css/js" → exact box):** `evaluate_script` to `querySelector`
the element + return `getBoundingClientRect()`, then feed that box to the CDP
`clip` — works even when an element has no clean a11y uid.

## Validated live (lemonde.fr article)

- element screenshot by uid → cropped to the targeted element (the headline). ✅
- one `evaluate_script` →
  `{ title (h1), bodyPreview (selector innerText), ld+json: author/datePublished/articleSection }`.
  `articleBody` empty (`bodyChars:0`) when paywalled — metadata + free intro
  still come through. ✅

## When a write button has no clean API

Locate it via `take_snapshot` (uid) and click; prefer the URL-entry form if the
action is a link (see `writes.md`). Re-snapshot before each click (uids drift).
