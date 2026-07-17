# Browser — cookies, consent, sessions, login gate

Cookies are both the **auth** and the **gate**. Handle deliberately.

## Inspect

- Non-HttpOnly (CSRF / consent tokens): `evaluate_script(() => document.cookie)`
  — enough for LinkedIn `JSESSIONID`, IG `csrftoken`, X `ct0`, `euconsent`.
- HttpOnly auth cookies (`sessionid`, `SAPISID`) aren't visible to JS — but they
  **ride same-origin fetches automatically**, so you rarely need to read them.
  Full jar: CDP `Network.getCookies` via the driver `send` escape hatch.

## CMP consent banners (EU sites — the silent blocker) ✅ validated

A GDPR wall (Didomi / Sourcepoint / OneTrust / Quantcast) blocks content +
scraping until accepted. **Clear it first** on any news/EU page:

- `take_snapshot` → click accept. Labels vary: `"Tout accepter"` / `"J'accepte"`
  / `"Accepter et continuer"` (lemonde ✅) / `"Continuer sans accepter"` /
  OneTrust `#onetrust-accept-btn-handler`.
- Persists `euconsent-v2` / `didomi_token` / `sp_*` → `hasConsent` flips
  false→true, wall cleared for the session (verified on lemonde.fr).

## Paywall / "browse as the logged-in user"

The cloned profile's cookies ARE the session (logged-in feeds, subscriber
paywalls). To inject a SYNCED session (browse as the user on a fresh context):

- browser-control cookie injection:
  `BrowserSessionProvider.getDecryptedForDomain` →
  `AttachOptions.sessionPayload` (headless context loads it as Playwright
  `storageState`; camofox injects `.cookies`). `browserListSavedLogins` to see
  which sites have a synced session.
- Or the guilde MCP `set_cookies` tool.
- Never exfiltrate cookies/tokens beyond the same-origin fetch a task needs.

## The login gate (the #1 prerequisite)

The cloned profile carries **only the logins present at clone time**. A platform
is reachable **iff** the profile is logged into it:

- Detect: snapshot for a logged-in marker / absence of a sign-in wall; **no auth
  cookie (`csrf`/`ct0`/`sessionid`) ⇒ logged out**.
- Observed: LinkedIn ✅, TikTok ✅; X ✗ (no ct0), YouTube ✗, Leboncoin ✗, IG ?.
- Fix: have the **user sign in once** in the cloned Chrome
  (`~/.agentproto/chrome-profile-guildebrowser`) → re-run. **Never fill
  credentials.**
