# Browser — write actions (gated)

> **HARD RULE: every write acts AS THE USER and is attributable** (a message, a
> connection invite, a like, a comment, a post). Never send speculatively. Each
> send needs **explicit per-action confirmation**. Harnesses are **draft-only by
> default**; the actual send sits behind an explicit `--send`-style flag.

## Pattern

1. **Prefer URL-entry over clicking navigating-links.** Many write entry points
   ARE links/URLs that open a prefilled composer (LinkedIn message:
   `/messaging/compose/?…&body=<prefilled>`; LinkedIn connect-note:
   `/preload/custom-invite/?vanityName=<v>`). Direct-navigate them — clicking
   the same link hangs.
2. **Draft → confirm → send.** Build the action (prefilled where possible),
   `take_snapshot` / screenshot the draft, **show the user**, then click the
   Send/confirm control (find its uid from a fresh snapshot; labels like
   `"Envoyer"`/`"Send"`/`"Envoyer une invitation"`, which may be **disabled
   until a required field is filled**).
3. **Verify** — re-snapshot/observe the result (thread shows your message, box
   cleared, etc.).

## Proven (LinkedIn)

- Message: compose URL with `body=` prefill → Send (✅ sent live).
- Connect-with-note: custom-invite URL → "Ajouter une note" → textbox (max 300)
  → "Envoyer une invitation" (✅ flow; gated).

## Rate + safety

- **Rate-limit + space writes human-like** — bursts get flagged (IG/TikTok
  worst).
- Reads can be logged too (profile views are visible to the target).
- One sanctioned send at a time; confirm each; never batch-send without per-item
  ok.
