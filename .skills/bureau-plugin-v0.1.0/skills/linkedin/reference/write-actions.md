# LinkedIn — write actions (gated)

> **HARD RULE: every write acts AS THE USER and is attributable.** Never send
> speculatively. Each send needs **explicit per-action confirmation**. Harnesses
> are **draft-only by default**; the actual send is behind `--send`.

## Message ✅ (proven — sent live to a consenting accomplice)

The profile "Message" action is a **link** to the compose page, and it accepts a
`body=` param that **prefills** the text. Skip the fragile overlay click:

```
navigate → https://www.linkedin.com/messaging/compose/?profileUrn=urn:li:fsd_profile:<ID>
            &recipient=<ID>&body=<urlencoded message>&interop=msgOverlay
take_snapshot → screenshot the draft → CONFIRM
click button "Envoyer" / "Send"
verify: your bubble in the thread, compose box cleared, sidebar shows "Vous : …"
```

Harness: `scripts/linkedin-message.ts [--send]` (no flag = open prefilled draft,
no send). Get `<ID>` from the profile Message link or the person's `fsd_profile`
URN. **Gotcha:** the generic text `"Message"` also matches the global search box
→ target the link/URL, not the text.

## Connect / withdraw — the relationship graph (productized 2026-06-14)

**Connect and withdraw are LinkedIn Server-Driven-UI actions, NOT clean Voyager
fetches.** Captured live: the connect button fires
`com.linkedin.sdui.requests.mynetwork.addaAddConnection`, the withdraw fires
`…addaWithdrawInvitation` (both
`POST /flagship-web/rsc-action/actions/ server-request?sduiid=…`). Their bodies
are **opaque, encoded SDUI state that rotates every release** and are behind a
**trusted-event wall** (a synthetic `.click()` is ignored). So — unlike
`message`/`react` — there is **no replayable endpoint to reverse-engineer**. The
durable design is to drive the REAL controls through the trusted-input resolver
ladder and read the relationship state back.

This is shipped as a neutral **`SocialNetworkPort`** (the trusted-input sibling
of the API-first action/conversation/media ports), reached as:

- **Bureau daemon tool** `social_network` — `action`: `invite` (pass `note` for
  a custom message, omit to send **without** a note — the higher-acceptance
  default) · `withdrawInvitation`. `target` = a profile URL/@handle. Returns the
  relationship `state` read back (`pending` / `connectable` / `connected`) — the
  PROOF the action took, never a blind click.
- **Operator tool** `bureauSocialNetwork` (Guilde) — same verbs; `invite`
  carries `requireApproval: true` (reaches a real person → always gated).
- **Workflow** `social-cancel-request` — bulk-withdraws pending sent requests
  (`bureau workflow run social-cancel-request --session linkedin --platform linkedin --targets <url1>,<url2>`).
  Single target = one-element list.

Implementation: `linkedin-network.ts` (`createLinkedInNetwork`) over a
`HumanSession`. Camofox renders the profile fine (it's only _single-post
permalinks_ that render degraded) — the action bar exposes the connect control
as **"Inviter \<name\> à rejoindre votre réseau"** (NOT a bare "Se connecter"),
with "Plus" overflow as a fallback when it's tucked away. Read-back gates on the
action bar hydrating (the name is **not** in an `h1`).

**Manual chrome-devtools fallback** (no Bureau): direct-navigate
`https://www.linkedin.com/preload/custom-invite/?vanityName=<vanity>` → "Ajouter
une note" → type (max 300 chars) → "Envoyer une invitation". Clicking the inline
"Se connecter" link times out; direct navigation is reliable.

- Only non-connections (2nd/3rd degree) can be invited; 1st-degree shows
  Message.
- Real invite-send is **gated for a consenting target** (same bar as the message
  test). A test invite to a non-complice is a durable, visible imposition — if
  one slips out, **withdraw it immediately** (`withdrawInvitation`, or the
  profile's "En attente → Retirer l'invitation" control).

## Mark inbox read ✅ (global, captured — `markRead` verb)

`social.act` verb `markRead` (omit `target`) clears the unread badge — the
confirmed GLOBAL contract, captured at the network level:

```
POST /voyager/api/voyagerMessagingDashMessagingBadge?action=markAllMessagesAsSeen
body: {"until": <epoch-ms>}   → 200, empty body
headers: csrf-token (=JSESSIONID), content-type application/json, x-restli-protocol-version 2.0.0
```

- **GOTCHA — the perf-log capture mislabels the METHOD.** The in-page fetch/XHR
  recorder (`social_capture_contract`) missed this request (it fires via a
  non-fetch path) and fell back to the **Performance resource log**, which
  reported it as a bodyless **GET** — a naive GET replay **400s**. The real
  request is a **POST with `{until}`**. Lesson: when a capture's `source` is
  `"resource"` (not a fetch hook), you have URL only — get the true method +
  body
  - headers from **chrome-devtools `get_network_request`** on the daily Chrome.
- **Per-conversation** mark-read (`MessengerConversations?ids=List(<conv>)`) is
  NOT wired — its write fires via the same non-fetch path, so there's no
  captured body to replay. `markRead` with a `target` returns a clear "not
  captured" error rather than guessing.

## Other writes (same discipline; capture the action endpoint when first run)

- **Like / react** a post: the reaction button → `voyagerSocialDashReactions`
  POST (reactionType). Comment: the comment box → `voyagerSocialDashComments`
  POST.
- **Follow**: the Follow button. Each is a write → gated + confirmed.
- **React to a MESSAGE** (DM emoji): SDUI-walled — no replayable fetch contract,
  same wall as message-unreact. Not wired.

## Safety rails

- Profile views ARE logged (the person sees it) — fine for
  connections/consenting, surprising otherwise.
- Connection invites + messages are durable + visible — never as a silent
  "test".
- Don't exfiltrate cookies/`JSESSIONID`/localStorage beyond the same-origin
  fetch.
- Screenshots = screenshare — minimize personal data; demo on public pages.
- Rate-limit writes; LinkedIn flags burst automation. Space actions, human-like.
